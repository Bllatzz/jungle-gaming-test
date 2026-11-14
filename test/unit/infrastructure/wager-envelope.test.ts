import { describe, expect, test } from 'bun:test';
import { nextReferenceAttemptAt } from '../../../src/application/resolve-pending-references';
import { parseEnvelope } from '../../../src/infrastructure/messaging/wager-consumer';
import { InvalidRequestError } from '../../../src/infrastructure/http/request-parsing';

// Envelope do §10 do desafio, igual ao exemplo
const data = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  idempotencyKey: 'provider-a:transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
  money: { amount: '25.00', currency: 'BRL' },
};
const envelope = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ messageId: 'msg-123', type: 'WagerTransactionRequested', occurredAt: '2026-07-29T15:00:00.000Z', data, ...overrides });

describe('parseEnvelope', () => {
  test('lê o exemplo do desafio: messageId e comando com a idempotencyKey de data', () => {
    const { messageId, command } = parseEnvelope(envelope());
    expect(messageId).toBe('msg-123');
    expect(command).toMatchObject({ idempotencyKey: 'provider-a:transaction-123', kind: 'BET', walletId: data.walletId });
    expect(command.money.toString()).toBe('25.00');
  });

  test.each([
    ['corpo vazio', undefined],
    ['não é JSON', 'isto não é json'],
    ['array', '[]'],
    ['type desconhecido', envelope({ type: 'Outro' })],
    ['sem messageId', envelope({ messageId: undefined })],
    ['sem data', envelope({ data: undefined })],
    ['sem idempotencyKey', envelope({ data: { ...data, idempotencyKey: undefined } })],
  ])('%s → InvalidRequestError (vai para a DLQ)', (_, body) => {
    expect(() => parseEnvelope(body)).toThrow(InvalidRequestError);
  });
});

test('backoff do worker de referências: 1s, 2s, 4s… com teto de 60s', () => {
  const now = new Date('2026-11-14T12:00:00.000Z');
  const delays = [1, 2, 3, 6, 7, 9].map((n) => (nextReferenceAttemptAt(n, now).getTime() - now.getTime()) / 1000);
  expect(delays).toEqual([1, 2, 4, 32, 60, 60]);
});
