import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace';
import { createApp } from '../../src/bootstrap';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { OutboxMessageEntity } from '../../src/infrastructure/persistence/entities';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { flushTracing, startTracing } from '../../src/infrastructure/observability/tracing';
import * as api from '../support/api-client';
import { freshTestDatabase } from '../support/test-database';
import { freshTestQueues } from '../support/test-queues';
import { SendMessageCommand } from '@aws-sdk/client-sqs';

// OpenTelemetry com o SDK de verdade e um exporter em memória (no lugar do OTLP → Jaeger): prova os spans e
// a propagação do traceparent HTTP → outbox → fila de eventos, e fila de entrada → consumer.

const exporter = new InMemorySpanExporter();
let app: INestApplication;
let orm: MikroORM;
let url: string;
let queues: Awaited<ReturnType<typeof freshTestQueues>>;

beforeAll(async () => {
  startTracing(undefined, exporter);
  queues = await freshTestQueues(await freshTestDatabase('tracing', true), 'tracing');
  app = await createApp(queues.env);
  app.useLogger(false);
  await app.listen(0);
  url = await app.getUrl();
  orm = await MikroORM.init(createOrmConfig(queues.env));
});
afterAll(async () => {
  await app.close();
  await orm.close();
  await queues.cleanup();
});

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const traceparent = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const spans = async () => {
  await flushTracing();
  return exporter.getFinishedSpans();
};

test('HTTP: span por requisição, filho do traceparent do cliente, com o desfecho da transação', async () => {
  const wallet = await api.openWallet(url, '100.00');
  const payload = api.wagerPayload(wallet, 'BET', '10.00');
  const res = await api.call(url, 'POST', '/wagering/transactions', payload, {
    'idempotency-key': `${payload.providerId}:${payload.externalTransactionId}`, traceparent,
  });
  expect(res.status).toBe(200);
  const span = (await spans()).find((s) => s.attributes['wager.transaction_id'] === res.body.transactionId);
  expect(span?.name).toBe('HTTP POST /wagering/transactions');
  expect(span?.spanContext().traceId).toBe(TRACE_ID);
  expect(span?.attributes).toMatchObject({ 'wager.status': 'PROCESSED', 'wager.replay': false, 'http.response.status_code': 200 });

  // o evento gravado na outbox carrega o mesmo trace, e o publisher o repassa como atributo da mensagem SQS
  const rows = await orm.em.fork().find(OutboxMessageEntity, { aggregateId: wallet.id, eventType: 'WagerTransactionProcessed' });
  const row = rows.find((r) => (r.payload as any).data.transactionId === res.body.transactionId)!;
  expect(row.traceparent).toContain(TRACE_ID);
  while ((await app.get(OutboxPublisher).publishPending()) > 0);
  const events = await queues.drain('events');
  const event = events.find((m) => JSON.parse(m.Body!).eventId === row.id)!;
  expect(event.MessageAttributes?.traceparent?.StringValue).toContain(TRACE_ID);
  expect((await spans()).some((s) => s.name === 'outbox.publish')).toBe(true);
});

test('SQS: a mensagem com traceparent vira um span filho no consumer', async () => {
  const wallet = await api.openWallet(url, '100.00');
  const data = api.wagerPayload(wallet, 'BET', '10.00');
  const otherTrace = randomUUID().replace(/-/g, '');
  await queues.sqs.send(new SendMessageCommand({
    QueueUrl: queues.urls.wager,
    MessageBody: JSON.stringify({
      messageId: randomUUID(), type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(),
      data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` },
    }),
    MessageGroupId: wallet.id,
    MessageDeduplicationId: randomUUID(),
    MessageAttributes: { traceparent: { DataType: 'String', StringValue: `00-${otherTrace}-00f067aa0ba902b7-01` } },
  }));
  for (const deadline = Date.now() + 6_000; Date.now() < deadline;) if ((await app.get(WagerConsumer).pollOnce(1)) > 0) break;
  const span = (await spans()).find((s) => s.name === 'sqs.process wager-transactions' && s.attributes['wager.wallet_id'] === wallet.id);
  expect(span?.spanContext().traceId).toBe(otherTrace);
  expect(span?.attributes['wager.status']).toBe('PROCESSED');
});
