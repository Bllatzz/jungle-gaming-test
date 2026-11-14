import type { WagerCommand } from '../../application/process-wager-transaction';
import { Money } from '../../domain/money';
import { WagerTransactionKind } from '../../domain/wager-transaction';

/** Payload malformado: 400. Validação de forma; as regras de valor ficam no domínio (Money, WagerTransaction). */
export class InvalidRequestError extends Error {}

const MAX_TEXT = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** OPENING é interno: não pode chegar pela API. */
const SUBMITTABLE_KINDS = new Set<string>([
  WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Loss,
  WagerTransactionKind.Refund, WagerTransactionKind.Rollback,
]);
/** Provider reservado para as transações internas (OPENING). */
const INTERNAL_PROVIDER = 'internal';

/** Sem espaço nas pontas: " tx-1" e "tx-1" seriam ids diferentes e furariam a deduplicação. */
export function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || value.length > MAX_TEXT) {
    throw new InvalidRequestError(`${field} deve ser texto de 1 a ${MAX_TEXT} caracteres, sem espaços nas pontas`);
  }
  return value;
}

export function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidRequestError(`${field} deve ser um UUID`);
  return value.toLowerCase();
}

function money(value: unknown, field: string): Money {
  if (typeof value !== 'object' || value === null) throw new InvalidRequestError(`${field} deve ser { amount, currency }`);
  const { amount, currency } = value as Record<string, unknown>;
  if (typeof amount !== 'string' || typeof currency !== 'string') {
    throw new InvalidRequestError(`${field}.amount e ${field}.currency devem ser strings`);
  }
  return Money.from({ amount, currency }); // InvalidMoneyError → 400
}

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new InvalidRequestError('Corpo deve ser um objeto JSON');
  return body as Record<string, unknown>;
}

export function parseWagerCommand(body: unknown, idempotencyKey: unknown): WagerCommand {
  const b = object(body);
  const providerId = text(b.providerId, 'providerId');
  if (providerId.toLowerCase() === INTERNAL_PROVIDER) throw new InvalidRequestError(`providerId "${INTERNAL_PROVIDER}" é reservado`);
  if (typeof b.kind !== 'string' || !SUBMITTABLE_KINDS.has(b.kind)) {
    throw new InvalidRequestError(`kind deve ser um de ${[...SUBMITTABLE_KINDS].join(', ')}`);
  }
  return {
    idempotencyKey: text(idempotencyKey, 'header Idempotency-Key'),
    providerId,
    externalTransactionId: text(b.externalTransactionId, 'externalTransactionId'),
    playerId: text(b.playerId, 'playerId'),
    walletId: uuid(b.walletId, 'walletId'),
    roundId: text(b.roundId, 'roundId'),
    gameId: text(b.gameId, 'gameId'),
    kind: b.kind as WagerTransactionKind,
    money: money(b.money, 'money'),
    referenceExternalTransactionId:
      b.referenceExternalTransactionId === undefined || b.referenceExternalTransactionId === null
        ? undefined
        : text(b.referenceExternalTransactionId, 'referenceExternalTransactionId'),
  };
}

export function parseOpenWallet(body: unknown): { playerId: string; initialBalance: Money } {
  const b = object(body);
  return { playerId: text(b.playerId, 'playerId'), initialBalance: money(b.initialBalance, 'initialBalance') };
}
