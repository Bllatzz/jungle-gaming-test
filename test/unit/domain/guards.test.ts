// Guardas e casos-limite: estado terminal, wallet errada, referências inválidas, limites e eventos.
import { describe, expect, test } from 'bun:test';
import { InvalidMoneyError, InvalidTransactionError, InvalidTransactionStateError } from '../../../src/domain/errors';
import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected } from '../../../src/domain/events/wager-events';
import { FailureCode as F } from '../../../src/domain/failure-codes';
import { Money } from '../../../src/domain/money';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { applyWager } from '../../../src/domain/wager-rules';
import { type WagerTransaction, WagerTransactionKind as K } from '../../../src/domain/wager-transaction';
import { openWallet, type Wallet } from '../../../src/domain/wallet';
import { brl, NOW, tx, walletWith } from './fixtures';

function apply(wallet: Wallet, transaction: WagerTransaction, reference?: WagerTransaction, alreadyReversed = false) {
  return applyWager({ wallet, transaction, reference, referenceAlreadyReversed: alreadyReversed, ledgerEntryId: `entry-${transaction.id}`, now: NOW });
}
const ctx = { eventId: 'e', correlationId: 'c', occurredAt: NOW };

describe('applyWager — guardas', () => {
  test('transação já terminal: lança ANTES de mexer na wallet', () => {
    const w = walletWith('100.00');
    const bet = tx(K.Bet, '10.00');
    apply(w, bet);
    expect(() => apply(w, bet)).toThrow(InvalidTransactionStateError);
    expect([w.balance.toString(), w.version]).toEqual(['90.00', 2]);
  });

  test('transação de outra wallet: erro de programação, wallet intacta', () => {
    const w = walletWith('100.00');
    expect(() => apply(w, tx(K.Bet, '10.00', { walletId: 'wallet-2' }))).toThrow(InvalidTransactionError);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('id do lançamento vem de fora (domínio determinístico)', () => {
    const w = walletWith('100.00');
    const bet = tx(K.Bet, '10.00');
    const d = apply(w, bet);
    expect(d.status === 'PROCESSED' && d.ledgerEntry?.id).toBe(`entry-${bet.id}`);
    const { opening } = openWallet({ walletId: 'w', playerId: 'p', initialBalance: brl('5.00'), openingTransactionId: 'op', openingLedgerEntryId: 'op-entry', now: NOW });
    expect(opening?.ledgerEntry.id).toBe('op-entry');
  });

  test('BET com referência: REFERENCE_INVALID_KIND na hora, sem ficar esperando', () => {
    expect(apply(walletWith('100.00'), tx(K.Bet, '1.00', { referenceExternalTransactionId: 'x' }))).toEqual({ status: 'REJECTED', failureCode: F.ReferenceInvalidKind });
  });

  test('auto-referência: rejeitada na hora', () => {
    const t = tx(K.Refund, '1.00', { externalTransactionId: 'same', referenceExternalTransactionId: 'same' });
    expect(apply(walletWith('100.00'), t, t)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceInvalidKind });
  });

  test('referência ainda pendente mas de outra rodada: REFERENCE_MISMATCH já, não espera', () => {
    const w = walletWith('100.00');
    const bet = tx(K.Bet, '1.00', { roundId: 'round-9' });
    expect(apply(w, tx(K.Refund, '1.00', { referenceExternalTransactionId: bet.externalTransactionId }), bet)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceMismatch });
  });

  test('reference passada sem a transação declarar referência: ignorada', () => {
    const w = walletWith('100.00');
    const bet = tx(K.Bet, '1.00');
    apply(w, bet);
    const win = tx(K.Win, '1.00');
    apply(w, win, bet);
    expect(win.referenceTransactionId).toBeUndefined();
  });

  test('reversão duplicada com valor errado: REFERENCE_ALREADY_REVERSED (sinal "não reenviar") tem prioridade', () => {
    const w = walletWith('100.00');
    const bet = tx(K.Bet, '10.00');
    apply(w, bet);
    expect(apply(w, tx(K.Refund, '9.00', { referenceExternalTransactionId: bet.externalTransactionId }), bet, true)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceAlreadyReversed });
  });

  test('crédito que estouraria NUMERIC(20,2): erro, wallet intacta', () => {
    const w = walletWith('999999999999999999.99');
    expect(() => apply(w, tx(K.Win, '0.01'))).toThrow(InvalidMoneyError);
    expect(w.balance.toString()).toBe('999999999999999999.99');
  });
});

describe('cobertura que faltava', () => {
  const setup = () => {
    const w = walletWith('100.00');
    const bet = tx(K.Bet, '10.00');
    apply(w, bet);
    return { w, bet };
  };

  test('ROLLBACK não referencia ROLLBACK', () => {
    const { w, bet } = setup();
    const rb = tx(K.Rollback, '10.00', { referenceExternalTransactionId: bet.externalTransactionId });
    apply(w, rb, bet);
    expect(apply(w, tx(K.Rollback, '10.00', { referenceExternalTransactionId: rb.externalTransactionId }), rb)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceInvalidKind });
  });

  test('ROLLBACK com valor diferente: AMOUNT_MISMATCH', () => {
    const { w, bet } = setup();
    expect(apply(w, tx(K.Rollback, '9.99', { referenceExternalTransactionId: bet.externalTransactionId }), bet)).toEqual({ status: 'REJECTED', failureCode: F.AmountMismatch });
  });

  test('referência FAILED: REFERENCE_NOT_PROCESSED', () => {
    const { w } = setup();
    const failed = tx(K.Bet, '10.00');
    failed.fail(F.InternalError);
    expect(apply(w, tx(K.Refund, '10.00', { referenceExternalTransactionId: failed.externalTransactionId }), failed)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceNotProcessed });
  });

  test('referência de outro player ou outra moeda: REFERENCE_MISMATCH', () => {
    const { w } = setup();
    const otherPlayer = tx(K.Bet, '10.00', { playerId: 'player-2' });
    otherPlayer.markProcessed(undefined, NOW);
    expect(apply(w, tx(K.Refund, '10.00', { referenceExternalTransactionId: otherPlayer.externalTransactionId }), otherPlayer).status).toBe('REJECTED');
    const otherCurrency = tx(K.Bet, '10.00', { money: Money.from({ amount: '10.00', currency: 'USD' }) });
    otherCurrency.markProcessed(undefined, NOW);
    expect(apply(w, tx(K.Refund, '10.00', { referenceExternalTransactionId: otherCurrency.externalTransactionId }), otherCurrency)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceMismatch });
  });
});

describe('eventos e outbox — guardas de estado', () => {
  test('factories recusam transação no estado errado', () => {
    const w = walletWith('100.00');
    const pending = tx(K.Bet, '1.00');
    expect(() => WagerTransactionRejected.from(pending, ctx)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionProcessed.from(pending, w, ctx)).toThrow(InvalidTransactionStateError);
    expect(() => WagerTransactionPendingReference.from(pending, ctx)).toThrow(InvalidTransactionStateError);
  });

  test('Processed.from recusa wallet de outra transação', () => {
    const t = tx(K.Loss, '0.00');
    t.markProcessed(undefined, NOW);
    const other = openWallet({ walletId: 'outra', playerId: 'player-1', initialBalance: brl('0.00'), openingTransactionId: 'o', openingLedgerEntryId: 'oe', now: NOW }).wallet;
    expect(() => WagerTransactionProcessed.from(t, other, ctx)).toThrow(InvalidTransactionStateError);
  });

  test('outbox: publicar duas vezes ou reagendar publicada é erro', () => {
    const t = tx(K.Loss, '0.00');
    t.markProcessed(undefined, NOW);
    const m = OutboxMessage.enqueue(WagerTransactionProcessed.from(t, walletWith('1.00'), ctx));
    m.markPublished(NOW);
    expect(() => m.markPublished(NOW)).toThrow(InvalidTransactionStateError);
    expect(() => m.scheduleRetry(NOW)).toThrow(InvalidTransactionStateError);
  });
});

test('Money.from com props null/undefined (JSON não confiável): InvalidMoneyError, não TypeError', () => {
  expect(() => Money.from(null as never)).toThrow(InvalidMoneyError);
  expect(() => Money.from(undefined as never)).toThrow(InvalidMoneyError);
});
