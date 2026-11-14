import { describe, expect, test } from 'bun:test';
import { InvalidTransactionError, InvalidTransactionStateError } from '../../../src/domain/errors';
import { FailureCode } from '../../../src/domain/failure-codes';
import { LedgerDirection } from '../../../src/domain/ledger-entry';
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from '../../../src/domain/wager-transaction';
import { brl, NOW, tx } from './fixtures';

describe('create', () => {
  test('nasce PENDING', () => {
    expect(tx(K.Bet, '10.00').status).toBe(S.Pending);
  });

  test('REFUND e ROLLBACK exigem referenceExternalTransactionId', () => {
    expect(() => tx(K.Refund, '10.00')).toThrow(InvalidTransactionError);
    expect(() => tx(K.Rollback, '10.00')).toThrow(InvalidTransactionError);
    expect(tx(K.Refund, '10.00', { referenceExternalTransactionId: 'ext-x' }).requiresReference()).toBe(true);
  });

  test('OPENING não pode ser criada pelo create (é interna)', () => {
    expect(() => tx(K.Opening, '10.00')).toThrow(InvalidTransactionError);
  });

  test('valor zero só é aceito em LOSS', () => {
    expect(() => tx(K.Bet, '0.00')).toThrow(InvalidTransactionError);
    expect(tx(K.Loss, '0.00').status).toBe(S.Pending);
  });
});

describe('transições', () => {
  test('PENDING → PROCESSED registra referência e processedAt', () => {
    const t = tx(K.Bet, '10.00');
    t.markProcessed('ref-id', NOW);
    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe('ref-id');
    expect(t.processedAt).toEqual(NOW);
    expect(t.isTerminal()).toBe(true);
  });

  test('PENDING → PENDING_REFERENCE → PENDING_REFERENCE (nova tentativa) → PROCESSED', () => {
    const t = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'ext-x' });
    t.markPendingReference();
    t.markPendingReference();
    expect(t.status).toBe(S.PendingReference);
    expect(t.isTerminal()).toBe(false);
    t.markProcessed('ref', NOW);
    expect(t.status).toBe(S.Processed);
  });

  test('reject e fail guardam o failureCode', () => {
    const r = tx(K.Bet, '10.00');
    r.reject(FailureCode.InsufficientFunds);
    expect([r.status, r.failureCode]).toEqual([S.Rejected, FailureCode.InsufficientFunds]);
    const f = tx(K.Bet, '10.00');
    f.fail(FailureCode.InternalError);
    expect([f.status, f.failureCode]).toEqual([S.Failed, FailureCode.InternalError]);
  });

  test.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed(undefined, NOW)],
    ['REJECTED', (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
    ['FAILED', (t: WagerTransaction) => t.fail(FailureCode.InternalError)],
  ])('%s é terminal: qualquer transição lança InvalidTransactionStateError', (_, toTerminal) => {
    const t = tx(K.Bet, '10.00');
    toTerminal(t);
    expect(() => t.markProcessed(undefined, NOW)).toThrow(InvalidTransactionStateError);
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
    expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
    expect(() => t.fail(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
  });
});

describe('consultas', () => {
  test('affectsBalance é false só para LOSS', () => {
    expect(tx(K.Loss, '0.00').affectsBalance()).toBe(false);
    expect(tx(K.Bet, '1.00').affectsBalance()).toBe(true);
  });

  test('matchesPayload: mesma key com payload diferente não é replay', () => {
    const t = tx(K.Bet, '10.00', { payloadHash: 'abc' });
    expect(t.matchesPayload('abc')).toBe(true);
    expect(t.matchesPayload('outro')).toBe(false);
  });

  test('ledgerDirectionFor: BET débito; WIN/REFUND crédito; ROLLBACK inverte a referência', () => {
    const bet = tx(K.Bet, '10.00');
    const win = tx(K.Win, '10.00');
    const refund = tx(K.Refund, '10.00', { referenceExternalTransactionId: 'x' });
    const rollback = tx(K.Rollback, '10.00', { referenceExternalTransactionId: 'x' });
    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollback.ledgerDirectionFor(refund)).toBe(LedgerDirection.Debit);
    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidTransactionError);
    expect(() => tx(K.Loss, '0.00').ledgerDirectionFor()).toThrow(InvalidTransactionError);
  });

  test('rehydrate não revalida (aceita estado terminal persistido)', () => {
    const t = WagerTransaction.rehydrate({ ...tx(K.Bet, '1.00').toState(), status: S.Rejected, failureCode: FailureCode.InsufficientFunds });
    expect(t.status).toBe(S.Rejected);
  });

  test('opening: única forma de criar OPENING, já PROCESSED', () => {
    const t = WagerTransaction.opening({ id: 'op', walletId: 'w', playerId: 'p', money: brl('5.00'), now: NOW });
    expect([t.kind, t.status]).toEqual([K.Opening, S.Processed]);
  });
});
