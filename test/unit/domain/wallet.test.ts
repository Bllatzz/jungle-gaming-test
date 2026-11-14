import { expect, test } from 'bun:test';
import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from '../../../src/domain/errors';
import { LedgerDirection } from '../../../src/domain/ledger-entry';
import { Money } from '../../../src/domain/money';
import { openWallet, Wallet } from '../../../src/domain/wallet';
import { WagerTransactionKind, WagerTransactionStatus } from '../../../src/domain/wager-transaction';
import { brl, NOW, walletWith } from './fixtures';

const LATER = new Date('2026-11-14T13:00:00.000Z');

test('open: version 1, saldo inicial, moeda vinda do saldo', () => {
  const w = walletWith('100.00');
  expect(w.version).toBe(1);
  expect(w.balance.toString()).toBe('100.00');
  expect(w.currency).toBe('BRL');
});

test('open rejeita saldo inicial negativo', () => {
  expect(() => Wallet.open({ id: 'w', playerId: 'p', initialBalance: brl('5.00').negate(), now: NOW })).toThrow(InvalidMoneyError);
});

test('debit: muda saldo, incrementa version e devolve o lançamento correspondente', () => {
  const w = walletWith('100.00');
  const entry = w.debit(brl('80.00'), 'tx-1', 'entry', LATER);
  expect(w.balance.toString()).toBe('20.00');
  expect(w.version).toBe(2);
  expect(w.updatedAt).toEqual(LATER);
  expect(entry.direction).toBe(LedgerDirection.Debit);
  expect(entry.balanceBefore.toString()).toBe('100.00');
  expect(entry.balanceAfter.toString()).toBe('20.00');
  expect(entry.transactionId).toBe('tx-1');
  expect(entry.walletId).toBe(w.id);
});

test('credit: soma, incrementa version, devolve lançamento', () => {
  const w = walletWith('0.00');
  const entry = w.credit(brl('50.00'), 'tx-2', 'entry', LATER);
  expect(w.balance.toString()).toBe('50.00');
  expect(w.version).toBe(2);
  expect(entry.direction).toBe(LedgerDirection.Credit);
});

test('debit além do saldo lança InsufficientFundsError e não muda nada', () => {
  const w = walletWith('100.00');
  w.debit(brl('80.00'), 'tx-1', 'entry', LATER);
  expect(() => w.debit(brl('80.00'), 'tx-2', 'entry', LATER)).toThrow(InsufficientFundsError);
  expect(w.balance.toString()).toBe('20.00');
  expect(w.version).toBe(2);
});

test('debit do saldo exato zera a wallet', () => {
  const w = walletWith('10.00');
  w.debit(brl('10.00'), 'tx', 'entry', LATER);
  expect(w.balance.isZero()).toBe(true);
});

test('moeda diferente da wallet lança CurrencyMismatchError', () => {
  const usd = Money.from({ amount: '1.00', currency: 'USD' });
  expect(() => walletWith('10.00').credit(usd, 'tx', 'entry', LATER)).toThrow(CurrencyMismatchError);
  expect(() => walletWith('10.00').debit(usd, 'tx', 'entry', LATER)).toThrow(CurrencyMismatchError);
});

test('valor zero não é movimento: debit/credit de 0 é rejeitado (version só muda quando o saldo muda)', () => {
  expect(() => walletWith('10.00').credit(brl('0.00'), 'tx', 'entry', LATER)).toThrow(InvalidMoneyError);
});

test('rehydrate reconstrói sem revalidar', () => {
  const w = Wallet.rehydrate({ id: 'w', playerId: 'p', currency: 'BRL', balance: brl('7.00'), version: 9, createdAt: NOW, updatedAt: LATER });
  expect(w.version).toBe(9);
  expect(w.balance.toString()).toBe('7.00');
});

test('openWallet com saldo > 0 gera OPENING processada + CREDIT de 0 → inicial; version 1', () => {
  const { wallet, opening } = openWallet({ walletId: 'w', playerId: 'p', initialBalance: brl('1000.00'), openingTransactionId: 'op-1', openingLedgerEntryId: 'op-entry', now: NOW });
  expect(wallet.version).toBe(1);
  expect(wallet.balance.toString()).toBe('1000.00');
  expect(opening?.transaction.kind).toBe(WagerTransactionKind.Opening);
  expect(opening?.transaction.status).toBe(WagerTransactionStatus.Processed);
  expect(opening?.ledgerEntry.balanceBefore.toString()).toBe('0.00');
  expect(opening?.ledgerEntry.balanceAfter.toString()).toBe('1000.00');
  expect(opening?.ledgerEntry.transactionId).toBe('op-1');
});

test('openWallet com saldo 0 não gera OPENING nem lançamento', () => {
  expect(openWallet({ walletId: 'w', playerId: 'p', initialBalance: brl('0.00'), openingTransactionId: 'op', openingLedgerEntryId: 'op-entry', now: NOW }).opening).toBeUndefined();
});
