import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { Env } from '../../src/config/env';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { InboxMessageEntity, LedgerEntryEntity, WagerTransactionEntity } from '../../src/infrastructure/persistence/entities';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { openWallet, reconcile, wagerPayload } from '../support/api-client';
import { freshTestDatabase, walletsDivergingFromLedger } from '../support/test-database';
import { freshTestQueues } from '../support/test-queues';

// kill -9 garantidamente ENTRE o commit e o ack (§13, cenário 5): o processo roda com
// FAULT_INJECTION=kill-after-commit e se mata com SIGKILL logo depois do commit. Outro processo, normal,
// recebe a redelivery. No teste de carga (messaging.test.ts) o kill cai em ponto aleatório; aqui é o ponto exato.

const PORTS = { faulty: 39121, healthy: 39122 };
let env: Env;
let queues: Awaited<ReturnType<typeof freshTestQueues>>;
let orm: MikroORM;
const procs: Subprocess[] = [];

function start(port: number, extra: Record<string, string> = {}): Subprocess {
  const proc = Bun.spawn(['bun', join(import.meta.dir, '../../src/main.ts')], {
    env: {
      ...process.env, PORT: String(port), DATABASE_URL: env.databaseUrl, WORKERS_ENABLED: 'true',
      SQS_WAGER_QUEUE: env.queues.wager, SQS_WAGER_DLQ: env.queues.wagerDlq, SQS_EVENTS_QUEUE: env.queues.events, ...extra,
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  procs.push(proc);
  return proc;
}
async function until(what: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await Bun.sleep(200)) if (await check()) return;
  throw new Error(`timeout esperando: ${what}`);
}
const live = (port: number) => fetch(`http://localhost:${port}/health/live`).then((r) => r.ok, () => false);

beforeAll(async () => {
  queues = await freshTestQueues(await freshTestDatabase('concurrency_crash', true), 'crash');
  env = queues.env;
  orm = await MikroORM.init(createOrmConfig(env));
});
afterAll(async () => {
  for (const p of procs) p.kill('SIGTERM');
  await Promise.all(procs.map((p) => p.exited));
  await orm.close();
  await queues.cleanup();
});

test('processo morto com SIGKILL entre o commit e o ack: a redelivery cai no inbox, um débito só', async () => {
  const faulty = start(PORTS.faulty, { FAULT_INJECTION: 'kill-after-commit' });
  await until('app com falha subir', () => live(PORTS.faulty), 10_000);
  const wallet = await openWallet(`http://localhost:${PORTS.faulty}`, '100.00');
  const bet = wagerPayload(wallet, 'BET', '30.00');
  const messageId = randomUUID();
  await queues.sendWager({ ...bet, idempotencyKey: `${bet.providerId}:${bet.externalTransactionId}` }, messageId);

  await faulty.exited;
  expect(faulty.signalCode).toBe('SIGKILL');
  // morreu depois do commit: efeito e inbox gravados...
  const tx = await orm.em.fork().findOneOrFail(WagerTransactionEntity, { externalTransactionId: bet.externalTransactionId });
  expect(tx.status).toBe(WagerTransactionStatus.Processed);
  expect(await orm.em.fork().count(InboxMessageEntity, { messageId })).toBe(1);
  // ...e antes do ack: a mensagem continua na fila (em voo, invisível)
  const visible = await queues.sqs.send(new ReceiveMessageCommand({ QueueUrl: queues.urls.wager, WaitTimeSeconds: 0 }));
  expect(visible.Messages ?? []).toEqual([]);

  start(PORTS.healthy);
  await until('app saudável subir', () => live(PORTS.healthy), 10_000);
  // a visibilidade do receive (30 s) vence e a mensagem volta para o app saudável, que cai no replay e faz ack
  // (sem ler a fila aqui: quem lê "rouba" a mensagem do app)
  await until('redelivery cair no replay', async () =>
    (await fetch(`http://localhost:${PORTS.healthy}/metrics`).then((r) => r.text())).includes('wager_duplicates_total{source="sqs"} 1'), 60_000);
  expect(await queues.drain('wager')).toEqual([]); // e o ack saiu: nada sobrou na fila

  expect(await orm.em.fork().count(LedgerEntryEntity, { transactionId: tx.id })).toBe(1);
  expect(await orm.em.fork().count(WagerTransactionEntity, { externalTransactionId: bet.externalTransactionId })).toBe(1);
  expect(await reconcile(`http://localhost:${PORTS.healthy}`, wallet.id)).toMatchObject({ consistent: true, storedBalance: { amount: '70.00' } });
  expect(await queues.drain('wagerDlq')).toEqual([]);
  expect(await walletsDivergingFromLedger(orm)).toEqual([]);
}, 120_000);
