import { describe, expect, test } from 'bun:test';
import { InvalidTransactionStateError } from '../../../src/domain/errors';
import { WagerTransactionPendingReference, WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged } from '../../../src/domain/events/wager-events';
import { FailureCode } from '../../../src/domain/failure-codes';
import { LedgerDirection } from '../../../src/domain/ledger-entry';
import { InboxMessage } from '../../../src/domain/inbox-message';
import { OutboxMessage } from '../../../src/domain/outbox-message';
import { applyWager } from '../../../src/domain/wager-rules';
import { WagerTransactionKind as K } from '../../../src/domain/wager-transaction';
import { NOW, tx, walletWith } from './fixtures';

const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const ctx = { eventId: 'evt-1', correlationId: 'corr-1', causationId: 'msg-1', occurredAt: NOW };

describe('InboxMessage', () => {
  test('receive → markProcessed; processar duas vezes é erro', () => {
    const m = InboxMessage.receive({ messageId: 'msg-1', consumerName: 'wager-consumer', payloadHash: 'h', receivedAt: NOW });
    expect(m.isProcessed()).toBe(false);
    m.markProcessed(at(1));
    expect(m.isProcessed()).toBe(true);
    expect(m.processedAt).toEqual(at(1));
    expect(() => m.markProcessed(at(2))).toThrow(InvalidTransactionStateError);
  });
});

describe('OutboxMessage', () => {
  const event = () => {
    const w = walletWith('100.00');
    const bet = tx(K.Bet, '10.00');
    const d = applyWager({ wallet: w, transaction: bet, reference: undefined, referenceAlreadyReversedBySameKind: false, ledgerEntryId: 'entry-x', now: NOW });
    if (d.status !== 'PROCESSED' || !d.ledgerEntry) throw new Error('setup');
    return WalletBalanceChanged.from(w, d.ledgerEntry, ctx);
  };

  test('enqueue guarda o envelope serializado e nasce pendente e devido', () => {
    const m = OutboxMessage.enqueue(event());
    expect(m.id).toBe('evt-1');
    expect(m.aggregateId).toBe('wallet-1');
    expect(m.eventType).toBe('WalletBalanceChanged');
    expect(m.payload).toMatchObject({ eventId: 'evt-1', eventType: 'WalletBalanceChanged', version: 1, occurredAt: NOW.toISOString() });
    expect([m.isPending(), m.isDue(NOW), m.attempts]).toEqual([true, true, 0]);
  });

  test('scheduleRetry: backoff exponencial 1s, 2s, 4s… com teto de 300s', () => {
    const m = OutboxMessage.enqueue(event());
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      m.scheduleRetry(NOW);
      delays.push((m.nextAttemptAt!.getTime() - NOW.getTime()) / 1000);
    }
    expect(delays.slice(0, 4)).toEqual([1, 2, 4, 8]);
    expect(delays.at(-1)).toBe(300);
    expect(m.attempts).toBe(12);
    expect(m.isDue(at(299))).toBe(false);
    expect(m.isDue(at(300))).toBe(true);
  });

  test('markPublished: deixa de ser pendente e devido', () => {
    const m = OutboxMessage.enqueue(event());
    m.markPublished(at(1));
    expect([m.isPending(), m.isDue(at(10)), m.publishedAt]).toEqual([false, false, at(1)]);
  });
});

describe('Eventos de integração', () => {
  test('WalletBalanceChanged: só MoneyProps (strings) no data, JSON estável', () => {
    const w = walletWith('100.00');
    const entry = w.debit(tx(K.Bet, '25.00').money, 'tx-x', 'entry-x', NOW);
    const json = WalletBalanceChanged.from(w, entry, ctx).toJSON();
    expect(json).toEqual({
      eventId: 'evt-1', eventType: 'WalletBalanceChanged', aggregateId: 'wallet-1', correlationId: 'corr-1',
      causationId: 'msg-1', occurredAt: NOW.toISOString(), version: 1,
      data: {
        walletId: 'wallet-1', transactionId: 'tx-x', direction: LedgerDirection.Debit,
        money: { amount: '25.00', currency: 'BRL' },
        balanceBefore: { amount: '100.00', currency: 'BRL' },
        balanceAfter: { amount: '75.00', currency: 'BRL' },
        walletVersion: 2,
      },
    });
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test('Processed, Rejected e PendingReference: aggregateId = walletId, eventType/version no tipo', () => {
    const w = walletWith('100.00');
    const loss = tx(K.Loss, '0.00');
    applyWager({ wallet: w, transaction: loss, reference: undefined, referenceAlreadyReversedBySameKind: false, ledgerEntryId: 'entry-x', now: NOW });
    const processed = WagerTransactionProcessed.from(loss, w, ctx).toJSON();
    expect(processed).toMatchObject({ eventType: 'WagerTransactionProcessed', version: 1, aggregateId: 'wallet-1' });
    expect(processed.data).toMatchObject({ transactionId: loss.id, kind: 'LOSS', status: 'PROCESSED', balance: { amount: '100.00', currency: 'BRL' } });

    const bet = tx(K.Bet, '500.00');
    bet.reject(FailureCode.InsufficientFunds);
    expect(WagerTransactionRejected.from(bet, ctx).toJSON()).toMatchObject({
      eventType: 'WagerTransactionRejected', aggregateId: 'wallet-1', data: { failureCode: 'INSUFFICIENT_FUNDS', money: { amount: '500.00' } },
    });

    const refund = tx(K.Refund, '1.00', { referenceExternalTransactionId: 'ext-futura' });
    refund.markPendingReference();
    expect(WagerTransactionPendingReference.from(refund, ctx).toJSON()).toMatchObject({
      eventType: 'WagerTransactionPendingReference', data: { referenceExternalTransactionId: 'ext-futura', status: 'PENDING_REFERENCE' },
    });
  });

  test('sem causationId, o campo não aparece no JSON', () => {
    const w = walletWith('100.00');
    const loss = tx(K.Loss, '0.00');
    loss.markProcessed(undefined, NOW);
    expect('causationId' in WagerTransactionProcessed.from(loss, w, { eventId: 'e', correlationId: 'c', occurredAt: NOW }).toJSON()).toBe(false);
  });
});
