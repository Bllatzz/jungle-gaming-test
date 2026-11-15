import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Env } from '../../src/config/env';
import { InboxMessageEntity, OutboxMessageEntity, WagerTransactionEntity } from '../../src/infrastructure/persistence/entities';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { call, openWallet, reconcile, send, wagerPayload } from '../support/api-client';
import { checkLedgerInvariantAfterEach, freshTestDatabase } from '../support/test-database';
import { freshTestQueues } from '../support/test-queues';

// 3 processos reais com consumer, publisher e worker de referências ligados, nas mesmas filas e banco.
// No meio da carga: um morre com kill -9 (depois de commits sem ack), outro recebe SIGTERM. Os dois voltam.

// abaixo de 32768: fora da faixa efêmera do Linux, que o kernel usa nas conexões de saída (pool, SQS) e dava EADDRINUSE
const ports = [29111, 29112, 29113];
const urls = ports.map((p) => `http://localhost:${p}`);
let env: Env;
checkLedgerInvariantAfterEach(() => env);
let queues: Awaited<ReturnType<typeof freshTestQueues>>;
let orm: MikroORM;
const instances = new Map<number, Subprocess>();
const stdout = new Map<number, Promise<string>>();

function start(port: number): Subprocess {
  const proc = Bun.spawn(['bun', join(import.meta.dir, '../../src/main.ts')], {
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: env.databaseUrl,
      SQS_WAGER_QUEUE: env.queues.wager,
      SQS_WAGER_DLQ: env.queues.wagerDlq,
      SQS_EVENTS_QUEUE: env.queues.events,
      WORKERS_ENABLED: 'true',
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  instances.set(port, proc);
  stdout.set(port, new Response(proc.stdout).text()); // lido desde já: o pipe cheio travaria o processo
  return proc;
}

async function until(what: string, check: () => Promise<boolean>, timeoutMs = 90_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await Bun.sleep(200)) if (await check()) return;
  throw new Error(`timeout esperando: ${what}`);
}
const live = (url: string) => fetch(`${url}/health/live`).then((r) => r.ok, () => false);

beforeAll(async () => {
  queues = await freshTestQueues(await freshTestDatabase('concurrency_messaging', true), 'conc', 5);
  env = queues.env;
  orm = await MikroORM.init(createOrmConfig(env));
  for (const port of ports) start(port);
  for (const url of urls) await until(`${url} subir`, () => live(url), 10_000);
});
afterAll(async () => {
  for (const p of instances.values()) p.kill('SIGTERM');
  await Promise.all([...instances.values()].map((p) => p.exited));
  await orm.close();
  await queues.cleanup();
});

test('kill -9 e SIGTERM no meio da carga, reinício: tudo aplicado uma vez e consistente', async () => {
  const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(urls[0]!, '100.00')));
  // por wallet: 15 apostas de 10.00 sobre 100.00 → 10 passam, 5 sem saldo; cada mensagem enviada 2× (redelivery)
  const messages = wallets.flatMap((w) =>
    Array.from({ length: 15 }, () => {
      const data = wagerPayload(w, 'BET', '10.00');
      return { messageId: randomUUID(), data: { ...data, idempotencyKey: `${data.providerId}:${data.externalTransactionId}` } };
    }),
  );
  // e uma REFUND que chega antes da BET referenciada (§13, item 7)
  const late = await openWallet(urls[0]!, '100.00');
  const lateBet = wagerPayload(late, 'BET', '40.00');
  const refund = wagerPayload(late, 'REFUND', '40.00', { referenceExternalTransactionId: lateBet.externalTransactionId });
  await queues.sendWager({ ...refund, idempotencyKey: `${refund.providerId}:${refund.externalTransactionId}` });

  for (const m of messages) await queues.sendWager(m.data, m.messageId);
  for (const m of messages) await queues.sendWager(m.data, m.messageId);

  const inboxCount = () => orm.em.fork().count(InboxMessageEntity, {});
  await until('carga começar', async () => (await inboxCount()) >= 10);
  instances.get(ports[0]!)!.kill('SIGKILL'); // morre no meio: commits sem ack voltam para a fila
  const graceful = instances.get(ports[1]!)!;
  graceful.kill('SIGTERM');
  // o Nest roda os hooks de shutdown e reenvia o sinal a si mesmo (143); o log prova que os workers pararam limpos
  expect(await graceful.exited).toBe(143);
  expect(await stdout.get(ports[1]!)).toContain('workers stopped');
  await instances.get(ports[0]!)!.exited;

  expect((await send(urls[2]!, lateBet)).body.status).toBe('PROCESSED');
  for (const port of ports.slice(0, 2)) start(port);
  for (const url of urls.slice(0, 2)) await until(`${url} voltar`, () => live(url), 10_000);

  // consistência final: toda mensagem no inbox uma vez, outbox publicada, referência resolvida
  await until('fila drenada', async () => (await inboxCount()) === messages.length + 1);
  await until('REFUND aplicada', async () =>
    (await orm.em.fork().findOne(WagerTransactionEntity, { externalTransactionId: refund.externalTransactionId }))?.status === 'PROCESSED');
  await until('outbox publicada', async () => (await orm.em.fork().count(OutboxMessageEntity, { publishedAt: null })) === 0);

  for (const w of wallets) {
    expect(await reconcile(urls[2]!, w.id)).toMatchObject({ consistent: true, storedBalance: { amount: '0.00' }, checkedEntries: 11 });
    const statuses = await orm.em.fork().find(WagerTransactionEntity, { walletId: w.id, kind: 'BET' as any }, { fields: ['status'] });
    expect(statuses.filter((t) => t.status === 'PROCESSED')).toHaveLength(10);
    expect(statuses.filter((t) => t.status === 'REJECTED')).toHaveLength(5);
  }
  expect(await reconcile(urls[2]!, late.id)).toMatchObject({ consistent: true, storedBalance: { amount: '100.00' } });
  expect(await queues.drain('wagerDlq')).toEqual([]);

  // cada evento da outbox chegou na fila de eventos (duplicatas do broker colapsam pelo eventId)
  const outboxIds = (await orm.em.fork().find(OutboxMessageEntity, {}, { fields: ['id'] })).map((m) => m.id).sort();
  const published = [...new Set((await queues.drain('events', 2)).map((m) => JSON.parse(m.Body!).eventId))].sort();
  expect(published).toEqual(outboxIds);
  expect((await call(urls[2]!, 'GET', '/health/ready')).status).toBe(200);
}, 180_000);
