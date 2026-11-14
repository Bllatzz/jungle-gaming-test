import { expect, test } from 'bun:test';
import { InvalidLedgerEntryError } from '../../../src/domain/errors';
import { LedgerDirection, WalletLedgerEntry } from '../../../src/domain/ledger-entry';
import { Money } from '../../../src/domain/money';
import { brl, NOW } from './fixtures';

const base = { id: 'e1', walletId: 'w1', transactionId: 't1', createdAt: NOW };

test('crédito e débito balanceados', () => {
  const credit = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('10.00'), balanceBefore: brl('5.00'), balanceAfter: brl('15.00') });
  const debit = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Debit, money: brl('5.00'), balanceBefore: brl('15.00'), balanceAfter: brl('10.00') });
  expect(credit.isBalanced()).toBe(true);
  expect(debit.isBalanced()).toBe(true);
});

test('create rejeita aritmética errada, saldo final negativo, valor não positivo e moeda misturada', () => {
  const usd = Money.from({ amount: '10.00', currency: 'USD' });
  const bad = [
    { direction: LedgerDirection.Credit, money: brl('10.00'), balanceBefore: brl('0.00'), balanceAfter: brl('9.99') },
    { direction: LedgerDirection.Debit, money: brl('10.00'), balanceBefore: brl('5.00'), balanceAfter: brl('5.00').negate() },
    { direction: LedgerDirection.Credit, money: brl('0.00'), balanceBefore: brl('5.00'), balanceAfter: brl('5.00') },
    { direction: LedgerDirection.Credit, money: usd, balanceBefore: brl('0.00'), balanceAfter: brl('10.00') },
  ];
  for (const props of bad) {
    expect(() => WalletLedgerEntry.create({ ...base, ...props })).toThrow(InvalidLedgerEntryError);
  }
});

test('imutabilidade estrutural: sem setters nem métodos de transição', () => {
  const entry = WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit, money: brl('1.00'), balanceBefore: brl('0.00'), balanceAfter: brl('1.00') });
  const methods = Object.getOwnPropertyNames(WalletLedgerEntry.prototype).filter((m) => m !== 'constructor');
  expect(methods).toEqual(['isBalanced']);
  expect(Object.isFrozen(entry)).toBe(true);
});
