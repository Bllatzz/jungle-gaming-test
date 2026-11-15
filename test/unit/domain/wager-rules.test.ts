import { describe, expect, test } from 'bun:test';
import { FailureCode as F } from '../../../src/domain/failure-codes';
import { LedgerDirection } from '../../../src/domain/ledger-entry';
import { Money } from '../../../src/domain/money';
import { applyWager } from '../../../src/domain/wager-rules';
import { type WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../../src/domain/wager-transaction';
import type { Wallet } from '../../../src/domain/wallet';
import { NOW, tx, walletWith } from './fixtures';

function apply(wallet: Wallet, transaction: WagerTransaction, reference?: WagerTransaction, alreadyReversed = false) {
  return applyWager({ wallet, transaction, reference, referenceAlreadyReversed: alreadyReversed, ledgerEntryId: `entry-${transaction.id}`, now: NOW });
}
/** Referência já aplicada (PROCESSED) na mesma wallet. */
function processed(wallet: Wallet, transaction: WagerTransaction): WagerTransaction {
  apply(wallet, transaction);
  expect(transaction.status).toBe(S.Processed);
  return transaction;
}
const refTo = (t: WagerTransaction) => ({ referenceExternalTransactionId: t.externalTransactionId });

describe('BET', () => {
  test('debita, gera 1 lançamento DEBIT e marca PROCESSED', () => {
    const w = walletWith('100.00');
    const bet = tx(K.Bet, '25.00');
    const d = apply(w, bet);
    expect(d.status).toBe('PROCESSED');
    expect(d.status === 'PROCESSED' && d.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe('75.00');
    expect(bet.status).toBe(S.Processed);
  });

  test('cenário obrigatório (sequencial): 100.00, duas BETs de 80.00 → 1 PROCESSED, 1 REJECTED, saldo 20.00, 1 lançamento', () => {
    const w = walletWith('100.00');
    const [a, b] = [tx(K.Bet, '80.00'), tx(K.Bet, '80.00')];
    const decisions = [apply(w, a), apply(w, b)];
    expect(decisions.map((d) => d.status)).toEqual(['PROCESSED', 'REJECTED']);
    expect(b.failureCode).toBe(F.InsufficientFunds);
    expect(w.balance.toString()).toBe('20.00');
    expect(decisions.filter((d) => d.status === 'PROCESSED' && d.ledgerEntry)).toHaveLength(1);
  });

  test('sem saldo: REJECTED INSUFFICIENT_FUNDS, saldo e version intactos, sem lançamento', () => {
    const w = walletWith('10.00');
    const d = apply(w, tx(K.Bet, '10.01'));
    expect(d).toEqual({ status: 'REJECTED', failureCode: F.InsufficientFunds });
    expect([w.balance.toString(), w.version]).toEqual(['10.00', 1]);
  });
});

describe('validações comuns', () => {
  test('moeda diferente da wallet → CURRENCY_MISMATCH', () => {
    const d = apply(walletWith('100.00'), tx(K.Bet, '1.00', { money: Money.from({ amount: '1.00', currency: 'USD' }) }));
    expect(d).toEqual({ status: 'REJECTED', failureCode: F.CurrencyMismatch });
  });

  test('player diferente do dono da wallet → WALLET_PLAYER_MISMATCH', () => {
    expect(apply(walletWith('100.00'), tx(K.Bet, '1.00', { playerId: 'outro' }))).toEqual({ status: 'REJECTED', failureCode: F.WalletPlayerMismatch });
  });
});

describe('WIN', () => {
  test('sem referência: credita', () => {
    const w = walletWith('0.00');
    expect(apply(w, tx(K.Win, '50.00')).status).toBe('PROCESSED');
    expect(w.balance.toString()).toBe('50.00');
  });

  test('referenciando a BET da rodada: credita e guarda o id interno da BET', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '10.00'));
    const win = tx(K.Win, '30.00', refTo(bet));
    apply(w, win, bet);
    expect(win.referenceTransactionId).toBe(bet.id);
    expect(w.balance.toString()).toBe('120.00');
  });

  test('referência ainda não chegou → PENDING_REFERENCE, sem mexer no saldo', () => {
    const w = walletWith('100.00');
    const win = tx(K.Win, '30.00', { referenceExternalTransactionId: 'ext-futura' });
    expect(apply(w, win)).toEqual({ status: 'PENDING_REFERENCE' });
    expect(win.status).toBe(S.PendingReference);
    expect(w.version).toBe(1);
  });

  test('referenciando algo que não é BET → REFERENCE_INVALID_KIND', () => {
    const w = walletWith('100.00');
    const otherWin = processed(w, tx(K.Win, '1.00'));
    expect(apply(w, tx(K.Win, '1.00', refTo(otherWin)), otherWin)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceInvalidKind });
  });
});

describe('LOSS', () => {
  test('PROCESSED sem lançamento e sem mexer em saldo/version', () => {
    const w = walletWith('100.00');
    const d = apply(w, tx(K.Loss, '0.00'));
    expect(d).toEqual({ status: 'PROCESSED', ledgerEntry: undefined });
    expect([w.balance.toString(), w.version]).toEqual(['100.00', 1]);
  });
});

test('LOSS pode referenciar a BET da rodada (registra o resultado sem mover saldo)', () => {
  const w = walletWith('100.00');
  const bet = processed(w, tx(K.Bet, '10.00'));
  const loss = tx(K.Loss, '0.00', refTo(bet));
  expect(apply(w, loss, bet)).toEqual({ status: 'PROCESSED', ledgerEntry: undefined });
  expect(loss.referenceTransactionId).toBe(bet.id);
});

describe('REFUND', () => {
  test('reverte uma BET PROCESSED com crédito de mesmo valor', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '40.00'));
    const refund = tx(K.Refund, '40.00', refTo(bet));
    const d = apply(w, refund, bet);
    expect(d.status === 'PROCESSED' && d.ledgerEntry?.direction).toBe(LedgerDirection.Credit);
    expect(refund.referenceTransactionId).toBe(bet.id);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('só referencia BET', () => {
    const w = walletWith('100.00');
    const win = processed(w, tx(K.Win, '5.00'));
    expect(apply(w, tx(K.Refund, '5.00', refTo(win)), win)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceInvalidKind });
  });

  test('valor diferente da referência → AMOUNT_MISMATCH (reversão parcial fora de escopo)', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '40.00'));
    expect(apply(w, tx(K.Refund, '39.99', refTo(bet)), bet)).toEqual({ status: 'REJECTED', failureCode: F.AmountMismatch });
  });

  test('referência já revertida por REFUND → REFERENCE_ALREADY_REVERSED', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '40.00'));
    expect(apply(w, tx(K.Refund, '40.00', refTo(bet)), bet, true)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceAlreadyReversed });
  });

  test('referência ausente → PENDING_REFERENCE; referência PENDING/PENDING_REFERENCE também espera', () => {
    const w = walletWith('100.00');
    expect(apply(w, tx(K.Refund, '1.00', { referenceExternalTransactionId: 'nao-chegou' })).status).toBe('PENDING_REFERENCE');
    const waitingBet = tx(K.Bet, '1.00');
    expect(apply(w, tx(K.Refund, '1.00', refTo(waitingBet)), waitingBet).status).toBe('PENDING_REFERENCE');
  });

  test('referência REJECTED → REFERENCE_NOT_PROCESSED', () => {
    const w = walletWith('1.00');
    const bet = tx(K.Bet, '50.00');
    apply(w, bet); // rejeitada por saldo
    expect(apply(w, tx(K.Refund, '50.00', refTo(bet)), bet)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceNotProcessed });
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['rodada', { roundId: 'round-2' }],
    ['wallet', { walletId: 'wallet-2' }],
  ])('referência de outro(a) %s → REFERENCE_MISMATCH', (_, override) => {
    const w = walletWith('100.00');
    const foreignBet = tx(K.Bet, '10.00', override);
    foreignBet.markProcessed(undefined, NOW);
    expect(apply(w, tx(K.Refund, '10.00', refTo(foreignBet)), foreignBet)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceMismatch });
  });
});

describe('ROLLBACK', () => {
  test('de BET: crédito', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '30.00'));
    apply(w, tx(K.Rollback, '30.00', refTo(bet)), bet);
    expect(w.balance.toString()).toBe('100.00');
  });

  test('de WIN: débito', () => {
    const w = walletWith('0.00');
    const win = processed(w, tx(K.Win, '30.00'));
    const d = apply(w, tx(K.Rollback, '30.00', refTo(win)), win);
    expect(d.status === 'PROCESSED' && d.ledgerEntry?.direction).toBe(LedgerDirection.Debit);
    expect(w.balance.toString()).toBe('0.00');
  });

  test('de REFUND: débito (desfaz o reembolso)', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '40.00'));
    const refund = tx(K.Refund, '40.00', refTo(bet));
    apply(w, refund, bet);
    apply(w, tx(K.Rollback, '40.00', refTo(refund)), refund);
    expect(w.balance.toString()).toBe('60.00');
  });

  test('reversão que deixaria saldo negativo → REVERSAL_INSUFFICIENT_FUNDS (≠ INSUFFICIENT_FUNDS)', () => {
    const w = walletWith('0.00');
    const win = processed(w, tx(K.Win, '30.00'));
    processed(w, tx(K.Bet, '20.00')); // jogador gastou parte do prêmio
    const d = apply(w, tx(K.Rollback, '30.00', refTo(win)), win);
    expect(d).toEqual({ status: 'REJECTED', failureCode: F.ReversalInsufficientFunds });
    expect(w.balance.toString()).toBe('10.00');
  });

  test('não referencia LOSS nem ROLLBACK', () => {
    const w = walletWith('100.00');
    const loss = processed(w, tx(K.Loss, '0.00'));
    expect(apply(w, tx(K.Rollback, '1.00', refTo(loss)), loss)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceInvalidKind });
  });

  test('referência já revertida por ROLLBACK → REFERENCE_ALREADY_REVERSED', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '10.00'));
    expect(apply(w, tx(K.Rollback, '10.00', refTo(bet)), bet, true)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceAlreadyReversed });
  });

  test('regra 4: BET já reembolsada não aceita ROLLBACK (uma reversão só, de qualquer tipo) — sem crédito duplo', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '80.00'));
    apply(w, tx(K.Refund, '80.00', refTo(bet)), bet);
    expect(w.balance.toString()).toBe('100.00');
    const rollback = tx(K.Rollback, '80.00', refTo(bet));
    // o use case informa que a BET já tem uma reversão PROCESSED (o REFUND acima)
    expect(apply(w, rollback, bet, true)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceAlreadyReversed });
    expect(w.balance.toString()).toBe('100.00');
  });
});

describe('WIN/LOSS sobre BET já revertida', () => {
  test('WIN referenciando BET já reembolsada → REFERENCE_ALREADY_REVERSED, sem pagar o prêmio', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '10.00'));
    const win = tx(K.Win, '50.00', refTo(bet));
    expect(apply(w, win, bet, true)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceAlreadyReversed });
    expect(w.balance.toString()).toBe('90.00');
  });

  test('LOSS referenciando BET já revertida → REFERENCE_ALREADY_REVERSED', () => {
    const w = walletWith('100.00');
    const bet = processed(w, tx(K.Bet, '10.00'));
    expect(apply(w, tx(K.Loss, '0.00', refTo(bet)), bet, true)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceAlreadyReversed });
  });
});

describe('PENDING_REFERENCE reprocessada', () => {
  test('referência pendente de tipo não permitido → REFERENCE_INVALID_KIND já (esperar não muda o tipo)', () => {
    const w = walletWith('100.00');
    const win = tx(K.Win, '10.00', { referenceExternalTransactionId: 'bet-que-nao-chegou' });
    apply(w, win);
    expect(win.status).toBe(S.PendingReference);
    expect(apply(w, tx(K.Refund, '10.00', refTo(win)), win)).toEqual({ status: 'REJECTED', failureCode: F.ReferenceInvalidKind });
  });

  test('quando a referência chega, a mesma transação é processada', () => {
    const w = walletWith('100.00');
    const bet = tx(K.Bet, '10.00');
    const refund = tx(K.Refund, '10.00', refTo(bet));
    apply(w, refund);
    expect(refund.status).toBe(S.PendingReference);
    apply(w, bet);
    apply(w, refund, bet);
    expect(refund.status).toBe(S.Processed);
    expect(w.balance.toString()).toBe('100.00');
  });
});
