import { createHash } from 'node:crypto';
import type { Money } from '../domain/money';
import type { WagerTransactionKind } from '../domain/wager-transaction';

/** Campos de negócio de uma transação: o que entra no hash. Header e idempotencyKey ficam de fora. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

/**
 * SHA-256 (hex) do JSON canônico: chaves em ordem alfabética, sem espaços, campos ausentes omitidos.
 * money passa pelo Money, então "25.0" e "25.00" geram o mesmo hash.
 */
export function wagerPayloadHash(payload: WagerPayload): string {
  // campos escolhidos um a um: quem chama pode passar um objeto maior (ex.: com idempotencyKey)
  const business = {
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: payload.money.toJSON(),
    referenceExternalTransactionId: payload.referenceExternalTransactionId,
  };
  return createHash('sha256').update(canonicalJson(business)).digest('hex');
}

/** Mesmo esquema para a abertura de wallet (POST /wallets com Idempotency-Key). */
export function openWalletPayloadHash(command: { playerId: string; initialBalance: Money }): string {
  return createHash('sha256')
    .update(canonicalJson({ playerId: command.playerId, initialBalance: command.initialBalance.toJSON() }))
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
