import { type CreateWagerTransactionProps, WagerTransaction, type WagerTransactionKind } from '../../../src/domain/wager-transaction';
import { Money } from '../../../src/domain/money';
import { Wallet } from '../../../src/domain/wallet';

export const NOW = new Date('2026-11-14T12:00:00.000Z');
export const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });

export function walletWith(balance: string): Wallet {
  return Wallet.open({ id: 'wallet-1', playerId: 'player-1', initialBalance: brl(balance), now: NOW });
}

let seq = 0; // só gera ids únicos; nenhum teste depende do valor
/** Transação válida da wallet-1/player-1/round-1; sobrescreva o que o teste precisar. */
export function tx(kind: WagerTransactionKind, amount: string, overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  seq++;
  return WagerTransaction.create({
    id: `tx-${seq}`,
    providerId: 'provider-a',
    externalTransactionId: `ext-${seq}`,
    idempotencyKey: `provider-a:ext-${seq}`,
    payloadHash: `hash-${seq}`,
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind,
    money: brl(amount),
    referenceExternalTransactionId: undefined,
    createdAt: NOW,
    ...overrides,
  });
}
