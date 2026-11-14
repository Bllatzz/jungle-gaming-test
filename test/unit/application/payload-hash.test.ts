import { expect, test } from 'bun:test';
import { wagerPayloadHash, type WagerPayload } from '../../../src/application/payload-hash';
import { Money } from '../../../src/domain/money';
import { WagerTransactionKind } from '../../../src/domain/wager-transaction';

const base: WagerPayload = {
  providerId: 'provider-a', externalTransactionId: 'tx-1', playerId: 'p', walletId: 'w',
  roundId: 'r', gameId: 'g', kind: WagerTransactionKind.Bet, money: Money.from({ amount: '25.00', currency: 'BRL' }),
};

test('mesmo payload em outra ordem de chaves → mesmo hash', () => {
  const reordered = Object.fromEntries(Object.entries(base).reverse()) as unknown as WagerPayload;
  expect(wagerPayloadHash(reordered)).toBe(wagerPayloadHash(base));
});

test('"25.0" e "25.00" são o mesmo valor → mesmo hash', () => {
  expect(wagerPayloadHash({ ...base, money: Money.from({ amount: '25.0', currency: 'BRL' }) })).toBe(wagerPayloadHash(base));
});

test('referência ausente e undefined são a mesma coisa', () => {
  expect(wagerPayloadHash({ ...base, referenceExternalTransactionId: undefined })).toBe(wagerPayloadHash(base));
});

test('qualquer campo de negócio diferente → hash diferente', () => {
  const variants: Partial<WagerPayload>[] = [
    { walletId: 'w2' }, { kind: WagerTransactionKind.Win }, { roundId: 'r2' },
    { money: Money.from({ amount: '25.01', currency: 'BRL' }) }, { money: Money.from({ amount: '25.00', currency: 'USD' }) },
    { referenceExternalTransactionId: 'tx-0' },
  ];
  for (const v of variants) expect(wagerPayloadHash({ ...base, ...v })).not.toBe(wagerPayloadHash(base));
});

test('idempotencyKey e campos extras não entram no hash', () => {
  const command = { ...base, idempotencyKey: 'provider-a:tx-1', correlationId: 'c' } as WagerPayload;
  expect(wagerPayloadHash(command)).toBe(wagerPayloadHash(base));
});

test('é SHA-256 em hex', () => {
  expect(wagerPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
});
