import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';
import { ReconcileWallet } from '../../src/application/reconcile-wallet';
import { ResolvePendingReferences } from '../../src/application/resolve-pending-references';
import { OutboxPublisher } from '../../src/infrastructure/messaging/outbox-publisher';
import { WagerRepository } from '../../src/infrastructure/persistence/wager.repository';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { JsonLogger } from '../../src/infrastructure/observability/json-logger';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import * as api from '../support/api-client';
import { corruptBalance, freshTestDatabase } from '../support/test-database';
import { freshTestQueues } from '../support/test-queues';

// /metrics e logs JSON com o app real (Postgres + LocalStack). Cada teste olha a diferença que ele causou.

let queues: Awaited<ReturnType<typeof freshTestQueues>>;
let app: INestApplication;
let orm: MikroORM;
let url: string;
const logs: Record<string, any>[] = [];
// o logger do Nest é global no processo: um app com useLogger(false) desliga o dos outros
const captureLogs = () => app.useLogger(new JsonLogger((line) => logs.push(JSON.parse(line))));

beforeAll(async () => {
  queues = await freshTestQueues(await freshTestDatabase('observability', true), 'obs');
  app = await createApp(queues.env);
  captureLogs();
  await app.listen(0);
  url = await app.getUrl();
  orm = await MikroORM.init(createOrmConfig(queues.env));
});
afterAll(async () => {
  await app.close();
  await orm.close();
  await queues.cleanup();
});

async function scrape(base = url): Promise<{ text: string; value: (series: string) => number }> {
  const res = await fetch(`${base}/metrics`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/plain');
  const text = await res.text();
  const value = (series: string) => {
    const line = text.split('\n').find((l) => l.startsWith(`${series} `));
    return line ? Number(line.slice(series.length + 1)) : 0;
  };
  return { text, value };
}

describe('métricas', () => {
  test('transações por status, duplicatas, conflitos e latência', async () => {
    const before = await scrape();
    const wallet = await api.openWallet(url, '100.00');
    const bet = api.wagerPayload(wallet, 'BET', '10.00');
    await api.send(url, bet);
    await api.send(url, bet); // replay
    await api.send(url, api.wagerPayload(wallet, 'BET', '500.00')); // sem saldo
    await api.send(url, { ...bet, money: { amount: '11.00', currency: 'BRL' } }); // mesma key, outro payload

    const after = await scrape();
    const delta = (s: string) => after.value(s) - before.value(s);
    expect(delta('wager_transactions_total{source="http",status="PROCESSED"}')).toBe(1);
    expect(delta('wager_transactions_total{source="http",status="REJECTED"}')).toBe(1);
    expect(delta('wager_duplicates_total{source="http"}')).toBe(1);
    expect(delta('wager_conflicts_total{code="IDEMPOTENCY_CONFLICT"}')).toBe(1);
    expect(delta('wager_processing_duration_seconds_count{source="http"}')).toBe(4);
  });

  test('pela fila: transação e redelivery contadas com source="sqs"; falha antes do commit conta retry', async () => {
    const before = await scrape();
    const wallet = await api.openWallet(url, '100.00');
    const bet = api.wagerPayload(wallet, 'BET', '10.00');
    const data = { ...bet, idempotencyKey: `${bet.providerId}:${bet.externalTransactionId}` };
    const messageId = randomUUID();
    await queues.sendWager(data, messageId);
    await queues.sendWager(data, messageId); // redelivery
    await app.get(WagerConsumer).pollOnce(1);

    const failing = spyOn(WagerRepository.prototype, 'enqueue').mockRejectedValueOnce(new Error('falha no meio'));
    await queues.sendWager({ ...data, externalTransactionId: randomUUID(), idempotencyKey: randomUUID() });
    await app.get(WagerConsumer).pollOnce(1);
    failing.mockRestore();

    const after = await scrape();
    const delta = (s: string) => after.value(s) - before.value(s);
    expect(delta('wager_transactions_total{source="sqs",status="PROCESSED"}')).toBe(1);
    expect(delta('wager_duplicates_total{source="sqs"}')).toBe(1);
    expect(delta('wager_retries_total{component="sqs_consumer"}')).toBe(1);
    const decided = logs.find((l) => l.msg === 'wager transaction decided' && l.messageId === messageId);
    expect(decided).toMatchObject({ correlationId: messageId, walletId: wallet.id, providerId: 'provider-a' });
    const retry = logs.find((l) => l.msg === 'message retry scheduled' && l.walletId === wallet.id);
    expect(retry).toMatchObject({ providerId: 'provider-a', receiveCount: 1 });
    expect(retry!.messageId).toBeDefined();
  });

  test('worker de referências: tentativa sem referência conta retry; resolução conta source="pending_worker"', async () => {
    const before = await scrape();
    const wallet = await api.openWallet(url, '100.00');
    const bet = api.wagerPayload(wallet, 'BET', '20.00');
    const refund = api.wagerPayload(wallet, 'REFUND', '20.00', { referenceExternalTransactionId: bet.externalTransactionId });
    expect((await api.send(url, refund)).status).toBe(202);
    await app.get(ResolvePendingReferences).runOnce(); // a BET ainda não chegou
    await api.send(url, bet);
    await orm.em.fork().getConnection().execute(
      `update wager_transactions set next_reference_attempt_at = now() where external_transaction_id = ?`, [refund.externalTransactionId]);
    await app.get(ResolvePendingReferences).runOnce();

    const after = await scrape();
    const delta = (s: string) => after.value(s) - before.value(s);
    expect(delta('wager_transactions_total{source="http",status="PENDING_REFERENCE"}')).toBe(1);
    expect(delta('wager_retries_total{component="pending_reference"}')).toBe(1);
    expect(delta('wager_transactions_total{source="pending_worker",status="PROCESSED"}')).toBe(1);
  });

  test('outbox com SQS fora: o lote vai para retry e conta wager_retries_total{component="outbox"}', async () => {
    while ((await app.get(OutboxPublisher).publishPending()) > 0);
    const broken = await createApp({ ...queues.env, queues: { ...queues.env.queues, events: 'fila-que-nao-existe.fifo' } });
    broken.useLogger(false);
    await broken.listen(0);
    try {
      await api.openWallet(url, '100.00'); // abertura: 2 eventos
      expect(await broken.get(OutboxPublisher).publishPending()).toBe(0);
      // cada instância tem o seu registro: a métrica está na que falhou
      expect((await scrape(await broken.getUrl())).value('wager_retries_total{component="outbox"}')).toBe(2);
    } finally {
      await broken.close();
      captureLogs();
    }
  });

  test('outbox lag: idade do evento pendente mais antigo; zera depois de publicar', async () => {
    await api.openWallet(url, '100.00');
    await Bun.sleep(1_100);
    const pending = await scrape();
    expect(pending.value('outbox_pending_messages')).toBeGreaterThan(0);
    expect(pending.value('outbox_lag_seconds')).toBeGreaterThanOrEqual(1);

    while ((await app.get(OutboxPublisher).publishPending()) > 0);
    const drained = await scrape();
    expect(drained.value('outbox_pending_messages')).toBe(0);
    expect(drained.value('outbox_lag_seconds')).toBe(0);
  });

  test('DLQ: contador por motivo e profundidade da fila', async () => {
    await queues.sendWager({}, randomUUID(), 'isto não é json');
    await app.get(WagerConsumer).pollOnce(1);
    const m = await scrape();
    expect(m.value('sqs_dead_lettered_total{error_code="INVALID_MESSAGE"}')).toBe(1);
    expect(m.value('sqs_dlq_messages')).toBe(1);
  });

  test('conflito de lock: estourar o lock_timeout da wallet conta na métrica', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const holder = orm.em.fork();
    await holder.begin();
    await holder.getConnection().execute('select 1 from wallets where id = ? for update', [wallet.id], 'all', holder.getTransactionContext());
    try {
      expect((await api.send(url, api.wagerPayload(wallet, 'BET', '1.00'))).status).toBe(503);
    } finally {
      await holder.rollback();
    }
    expect((await scrape()).value('wager_lock_conflicts_total{type="lock_timeout"}')).toBe(1);
  }, 15_000);

  test('divergência de reconciliação: sinalizada, logada e contada (nunca corrigida)', async () => {
    const wallet = await api.openWallet(url, '100.00');
    await corruptBalance(queues.env, wallet.id, '90.00'); // corrompe o saldo contornando o banco
    expect(await api.reconcile(url, wallet.id)).toMatchObject({ consistent: false });
    expect((await scrape()).value('reconciliation_divergences_total')).toBe(1);
    expect(logs.some((l) => l.level === 'error' && l.msg === 'wallet balance diverges from ledger' && l.walletId === wallet.id)).toBe(true);

    // a auditoria periódica (worker) acha a mesma wallet sozinha, sem ninguém pedir a reconciliação
    expect(await app.get(ReconcileWallet).sweep()).toBe(1);
    expect((await scrape()).value('reconciliation_divergences_total')).toBe(2);
    expect(logs.some((l) => l.msg === 'wallet balance diverges from ledger (sweep)' && l.walletId === wallet.id
      && l.ledgerBalance === '100.00' && l.postingsBalance === '100.00')).toBe(true);
    expect((await api.call(url, 'GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('90.00'); // nunca corrige
  });

  test('banco fora do ar: /metrics responde os contadores sem os gauges do banco', async () => {
    const down = await createApp({ ...queues.env, databaseUrl: 'postgres://wagering:wagering@localhost:1/wagering' });
    down.useLogger(false);
    await down.listen(0);
    try {
      const res = await fetch(`${await down.getUrl()}/metrics`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('# TYPE wager_transactions_total counter');
      expect(text).not.toContain('outbox_lag_seconds');
      // instância recém-subida: contadores já existem com 0 (rate()/alertas desde o deploy)
      for (const series of ['wager_transactions_total{source="http",status="PROCESSED"}', 'wager_duplicates_total{source="sqs"}',
        'sqs_dead_lettered_total{error_code="RETRIES_EXHAUSTED"}', 'wager_lock_conflicts_total{type="lock_timeout"}', 'reconciliation_divergences_total']) {
        expect(text.split('\n')).toContain(`${series} 0`);
      }
    } finally {
      await down.close();
      captureLogs();
    }
  });
});

test('log JSON da decisão: campos de correlação, sem valores nem saldos', async () => {
  const wallet = await api.openWallet(url, '100.00');
  const bet = api.wagerPayload(wallet, 'BET', '12.34');
  const res = await api.call(url, 'POST', '/wagering/transactions', bet, {
    'idempotency-key': `${bet.providerId}:${bet.externalTransactionId}`, 'x-correlation-id': 'corr-123',
  });
  const line = logs.find((l) => l.msg === 'wager transaction decided' && l.transactionId === res.body.transactionId);
  expect(line).toMatchObject({
    level: 'info', context: 'ProcessWagerTransaction', correlationId: 'corr-123',
    transactionId: res.body.transactionId, walletId: wallet.id, providerId: 'provider-a', status: 'PROCESSED', replay: false,
  });
  expect(JSON.stringify(line)).not.toContain('12.34');
  expect(JSON.stringify(line)).not.toContain('87.66');
});
