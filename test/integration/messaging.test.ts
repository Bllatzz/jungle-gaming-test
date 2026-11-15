import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ChangeMessageVisibilityCommand, type Message, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { ProcessWagerTransaction } from '../../src/application/process-wager-transaction';
import { MAX_REFERENCE_ATTEMPTS, ResolvePendingReferences } from '../../src/application/resolve-pending-references';
import { createApp } from '../../src/bootstrap';
import type { Env } from '../../src/config/env';
import { OutboxPublisher, SQS_TIMEOUT_MS } from '../../src/infrastructure/messaging/outbox-publisher';
import { CONSUMER_NAME, MAX_RECEIVES, MAX_TRANSIENT_RECEIVES, WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import {
  InboxMessageEntity, LedgerEntryEntity, OutboxMessageEntity, WagerTransactionEntity,
} from '../../src/infrastructure/persistence/entities';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { WagerRepository } from '../../src/infrastructure/persistence/wager.repository';
import * as api from '../support/api-client';
import { freshTestDatabase, walletsDivergingFromLedger } from '../support/test-database';
import { freshTestQueues } from '../support/test-queues';

// Consumer, outbox e worker de referências contra Postgres e LocalStack reais. Workers desligados no app:
// cada teste chama a volta que quer (pollOnce, publishPending, runOnce) — sem esperar timers.

let env: Env;
let queues: Awaited<ReturnType<typeof freshTestQueues>>;
let app: INestApplication;
let orm: MikroORM;
let url: string;
let consumer: WagerConsumer;

beforeAll(async () => {
  queues = await freshTestQueues(await freshTestDatabase('messaging', true), 'messaging');
  env = queues.env;
  app = await createApp(env);
  app.useLogger(false);
  await app.listen(0);
  url = await app.getUrl();
  consumer = app.get(WagerConsumer);
  orm = await MikroORM.init(createOrmConfig(env));
});
afterAll(async () => {
  await app.close();
  await orm.close();
  await queues.cleanup();
});

/** `data` do envelope do §10 (inclui a idempotencyKey). */
function wagerData(wallet: api.TestWallet, kind: string, amount: string, extra: Record<string, unknown> = {}): Record<string, any> {
  const payload = api.wagerPayload(wallet, kind, amount, extra);
  return { ...payload, idempotencyKey: `${payload.providerId}:${payload.externalTransactionId}` };
}
const poll = () => consumer.pollOnce(1);
/** O LocalStack reexibe mensagens com atraso variável depois do backoff: espera até chegar, com prazo. */
async function pollUntilReceived(c = consumer, timeoutMs = 6_000): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) if ((await c.pollOnce(1)) > 0) return;
  throw new Error('a mensagem não voltou para a fila');
}
const db = () => orm.em.fork();
const balance = async (walletId: string) => (await api.call(url, 'GET', `/wallets/${walletId}`)).body.balance.amount;
const transactionOf = (data: Record<string, any>): Promise<Record<string, any>> =>
  db().findOneOrFail(WagerTransactionEntity, { providerId: data.providerId, externalTransactionId: data.externalTransactionId });
const dlqCodes = async () => (await queues.drain('wagerDlq')).map((m) => m.MessageAttributes?.errorCode?.StringValue);

describe('consumer', () => {
  test('processa, grava o inbox na mesma transação e faz ack', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const data = wagerData(wallet, 'BET', '10.00');
    const messageId = randomUUID();
    await queues.sendWager(data, messageId);

    expect(await poll()).toBe(1);
    expect(await balance(wallet.id)).toBe('90.00');
    expect(await db().count(InboxMessageEntity, { consumerName: CONSUMER_NAME, messageId })).toBe(1);
    expect((await transactionOf(data)).status).toBe('PROCESSED');
    expect(await queues.drain('wager')).toEqual([]); // ack
  });

  test('redelivery do mesmo messageId → um efeito só, as duas cópias com ack', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const data = wagerData(wallet, 'BET', '10.00');
    const messageId = randomUUID();
    await queues.sendWager(data, messageId);
    await queues.sendWager(data, messageId);

    expect(await poll()).toBe(2);
    expect(await balance(wallet.id)).toBe('90.00');
    expect(await db().count(InboxMessageEntity, { messageId })).toBe(1);
    expect(await db().count(LedgerEntryEntity, { walletId: wallet.id })).toBe(2); // abertura + 1 débito
    expect(await queues.drain('wager')).toEqual([]);
  });

  test('morte depois do commit e antes do ack → redelivery cai no replay, sem duplicar', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const data = wagerData(wallet, 'BET', '10.00');
    await queues.sendWager(data);
    const ack = spyOn(consumer as any, 'delete').mockRejectedValueOnce(new Error('processo morreu antes do ack'));

    await poll(); // commit feito, ack falhou: a mensagem volta na hora (visibilidade 0) e cai no replay
    ack.mockRestore();
    expect(await balance(wallet.id)).toBe('90.00');
    await pollUntilReceived();

    expect(await balance(wallet.id)).toBe('90.00');
    expect(await db().count(LedgerEntryEntity, { walletId: wallet.id })).toBe(2);
    expect(await queues.drain('wager')).toEqual([]);
    expect(await api.reconcile(url, wallet.id)).toMatchObject({ consistent: true });
  });

  test('atomicidade: falha antes do commit não deixa inbox, ledger nem saldo; o retry aplica uma vez', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const data = wagerData(wallet, 'BET', '10.00');
    const messageId = randomUUID();
    await queues.sendWager(data, messageId);
    const enqueue = spyOn(WagerRepository.prototype, 'enqueue').mockRejectedValueOnce(new Error('falha no meio'));

    await poll();
    enqueue.mockRestore();
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await db().count(InboxMessageEntity, { messageId })).toBe(0);
    expect(await db().count(WagerTransactionEntity, { externalTransactionId: data.externalTransactionId })).toBe(0);

    await pollUntilReceived();
    expect(await balance(wallet.id)).toBe('90.00');
    expect(await db().count(InboxMessageEntity, { messageId })).toBe(1);
  });

  test('rejeição de negócio é terminal: grava REJECTED e faz ack (não vai para a DLQ)', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const data = wagerData(wallet, 'BET', '500.00');
    await queues.sendWager(data);

    await poll();
    expect(await transactionOf(data)).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    expect(await queues.drain('wager')).toEqual([]);
    expect(await dlqCodes()).toEqual([]);
  });

  test('o que nunca vai dar certo vai direto para a DLQ, com o motivo', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const reused = randomUUID();
    await queues.sendWager({}, randomUUID(), 'isto não é json');
    await queues.sendWager(wagerData(wallet, 'BET', '10.001'));
    await queues.sendWager(wagerData({ id: randomUUID(), playerId: 'p' }, 'BET', '1.00'));
    await queues.sendWager(wagerData(wallet, 'BET', '1.00'), reused);
    await queues.sendWager(wagerData(wallet, 'BET', '2.00'), reused); // mesmo messageId, outro corpo

    for (let i = 0; i < 5 && (await poll()) > 0; i++);
    expect((await dlqCodes()).sort()).toEqual(['INVALID_MESSAGE', 'INVALID_MONEY', 'MESSAGE_ID_CONFLICT', 'WALLET_NOT_FOUND']);
    expect(await balance(wallet.id)).toBe('99.00'); // só a primeira com o messageId reutilizado
    expect(await queues.drain('wager')).toEqual([]);
  }, 15_000); // até 5 voltas de long polling: os 5 s padrão estouraram com o LocalStack recém-subido

  test(`transitório: retry com backoff e, só no ${MAX_TRANSIENT_RECEIVES}º recebimento, DLQ`, async () => {
    // segunda instância com o banco fora do ar, nas mesmas filas
    const down = await createApp({ ...env, databaseUrl: 'postgres://wagering:wagering@localhost:1/wagering' });
    down.useLogger(false);
    await down.init();
    try {
      const wallet = await api.openWallet(url, '100.00');
      await queues.sendWager(wagerData(wallet, 'BET', '10.00'));

      expect(await down.get(WagerConsumer).pollOnce(1)).toBe(1); // falha transitória → volta em 1s
      const hidden = await queues.sqs.send(new ReceiveMessageCommand({ QueueUrl: queues.urls.wager, WaitTimeSeconds: 0 }));
      expect(hidden.Messages ?? []).toEqual([]); // backoff: invisível, não foi deletada

      // banco fora não esgota o orçamento de bug (MAX_RECEIVES): a mensagem válida continua em retry
      expect(MAX_TRANSIENT_RECEIVES).toBeGreaterThan(MAX_RECEIVES);
      // gasta os recebimentos 2..8 sem esperar o backoff real (2s, 4s, 8s…)
      for (let receive = 2; receive < MAX_TRANSIENT_RECEIVES; receive++) {
        let Messages: Message[] = [];
        for (const deadline = Date.now() + 6_000; Messages.length === 0 && Date.now() < deadline;) {
          ({ Messages = [] } = await queues.sqs.send(new ReceiveMessageCommand({
            QueueUrl: queues.urls.wager, WaitTimeSeconds: 1, MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          })));
        }
        expect(Messages[0]?.Attributes?.ApproximateReceiveCount).toBe(String(receive));
        await queues.sqs.send(new ChangeMessageVisibilityCommand({
          QueueUrl: queues.urls.wager, ReceiptHandle: Messages[0]!.ReceiptHandle, VisibilityTimeout: 0,
        }));
      }

      await pollUntilReceived(down.get(WagerConsumer));
      expect(await dlqCodes()).toEqual(['RETRIES_EXHAUSTED']);
      expect(await queues.drain('wager')).toEqual([]);
      expect(await balance(wallet.id)).toBe('100.00');
    } finally {
      await down.close();
    }
  }, 90_000);

  test(`banco fora no ${MAX_RECEIVES}º recebimento e de volta: a mensagem é aplicada, não vai para a DLQ`, async () => {
    const down = await createApp({ ...env, databaseUrl: 'postgres://wagering:wagering@localhost:1/wagering' });
    down.useLogger(false);
    await down.init();
    try {
      const wallet = await api.openWallet(url, '100.00');
      await queues.sendWager(wagerData(wallet, 'BET', '10.00'));
      // recebimentos 1..MAX_RECEIVES-1 sem processar; o MAX_RECEIVES-ésimo falha com o banco fora
      for (let receive = 1; receive < MAX_RECEIVES; receive++) {
        let Messages: Message[] = [];
        for (const deadline = Date.now() + 6_000; Messages.length === 0 && Date.now() < deadline;) {
          ({ Messages = [] } = await queues.sqs.send(new ReceiveMessageCommand({ QueueUrl: queues.urls.wager, WaitTimeSeconds: 1 })));
        }
        await queues.sqs.send(new ChangeMessageVisibilityCommand({
          QueueUrl: queues.urls.wager, ReceiptHandle: Messages[0]!.ReceiptHandle, VisibilityTimeout: 0,
        }));
      }
      await pollUntilReceived(down.get(WagerConsumer));
      expect(await dlqCodes()).toEqual([]); // transitório: retry, não DLQ

      await pollUntilReceived(consumer, 30_000); // banco de volta: aplicada depois do backoff
      expect(await balance(wallet.id)).toBe('90.00');
      expect(await dlqCodes()).toEqual([]);
      expect(await queues.drain('wager')).toEqual([]);
    } finally {
      await down.close();
    }
  }, 60_000);
});

describe('consumer conta as próprias falhas', () => {
  test('mensagem só devolvida várias vezes (receive count alto) que falha uma vez não vai para a DLQ', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const data = wagerData(wallet, 'BET', '10.00');
    const messageId = randomUUID();
    await queues.sendWager(data, messageId);
    // recebida e devolvida sem processar MAX_RECEIVES vezes (como irmã de um grupo bloqueado, ou shutdown)
    for (let i = 0; i < MAX_RECEIVES; i++) {
      let Messages: Message[] = [];
      for (const deadline = Date.now() + 6_000; Messages.length === 0 && Date.now() < deadline;) {
        ({ Messages = [] } = await queues.sqs.send(new ReceiveMessageCommand({ QueueUrl: queues.urls.wager, WaitTimeSeconds: 1 })));
      }
      await queues.sqs.send(new ChangeMessageVisibilityCommand({
        QueueUrl: queues.urls.wager, ReceiptHandle: Messages[0]!.ReceiptHandle, VisibilityTimeout: 0,
      }));
    }
    const transient = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const fail = spyOn(ProcessWagerTransaction.prototype, 'execute').mockRejectedValueOnce(transient);
    try {
      await pollUntilReceived(); // 1ª falha de processamento desta mensagem: retry, não DLQ
    } finally {
      fail.mockRestore();
    }
    const [row] = await db().getConnection().execute(
      `select failures from consumer_message_failures where consumer_name = ? and message_id = ?`, [CONSUMER_NAME, messageId],
    );
    expect(row).toEqual({ failures: 1 });
    await pollUntilReceived(); // volta depois do backoff de 1 s e processa
    expect(await dlqCodes()).toEqual([]);
    expect(await balance(wallet.id)).toBe('90.00');
  }, 30_000);
});

describe('outbox', () => {
  const pendingOutbox = () => db().count(OutboxMessageEntity, { publishedAt: null });

  test('dois publishers sobre a mesma outbox: cada evento publicado uma vez, nada perdido', async () => {
    const publisherA = app.get(OutboxPublisher);
    while ((await publisherA.publishPending()) > 0); // zera o que os outros testes deixaram
    await queues.drain('events');

    // eventos commitados por esta instância, que "morre" sem publicar: outra instância assume
    // mais de duas reservas (50 por volta, publicadas em lotes paralelos de 10): os dois publishers disputam
    const wallets = await Promise.all(Array.from({ length: 6 }, () => api.openWallet(url, '100.00')));
    await Promise.all(wallets.flatMap((w) => Array.from({ length: 8 }, () => api.send(url, api.wagerPayload(w, 'BET', '1.00')))));
    const pending = await pendingOutbox();
    expect(pending).toBeGreaterThan(100);

    const other = await createApp(env);
    other.useLogger(false);
    await other.init();
    try {
      const publisherB = other.get(OutboxPublisher);
      const drainWith = async (p: OutboxPublisher) => {
        let total = 0;
        for (let n; (n = await p.publishPending()) > 0;) total += n;
        return total;
      };
      const [a, b] = await Promise.all([drainWith(publisherA), drainWith(publisherB)]);
      expect(a + b).toBe(pending); // SKIP LOCKED: lotes disjuntos
      expect(await pendingOutbox()).toBe(0);

      const events = (await queues.drain('events')).map((m) => JSON.parse(m.Body!));
      expect(events).toHaveLength(pending);
      expect(new Set(events.map((e) => e.eventId)).size).toBe(pending);
      expect(events.every((e) => wallets.some((w) => w.id === e.aggregateId))).toBe(true);

      // ordem estrita por wallet: cada wallet tem mais de um lote de 10 e dois publishers disputando, e mesmo
      // assim a FIFO entrega os eventos dela na ordem em que foram gravados na outbox
      for (const w of wallets) {
        // seq: a ordem em que a outbox gravou (sequência do banco), independente do relógio do app
        const written = await db().getConnection().execute<{ id: string }[]>(
          'select id from outbox_messages where aggregate_id = ? order by seq', [w.id]);
        expect(written.length).toBeGreaterThan(10);
        expect(events.filter((e) => e.aggregateId === w.id).map((e) => e.eventId)).toEqual(written.map((m) => m.id));
      }
    } finally {
      await other.close();
    }
  });

  test('morte depois de publicar e antes do commit → republica o mesmo eventId (duplicata segura)', async () => {
    const publisher = app.get(OutboxPublisher);
    while ((await publisher.publishPending()) > 0);
    await queues.drain('events');
    await api.openWallet(url, '100.00');
    const pending = await pendingOutbox();
    expect(pending).toBeGreaterThan(0);

    const save = spyOn(WagerRepository.prototype, 'saveOutbox').mockRejectedValueOnce(new Error('morreu antes do commit'));
    await expect(publisher.publishPending()).rejects.toThrow('morreu antes do commit');
    save.mockRestore();
    expect(await pendingOutbox()).toBe(pending); // nada marcado como publicado
    // o lote continua reservado (lease) e ninguém o pega antes de vencer — nem este publisher
    expect(await publisher.publishPending()).toBe(0);

    // a reserva vence (o publisher "morto" não volta): o lote sai de novo
    await db().nativeUpdate(OutboxMessageEntity, { publishedAt: null }, { nextAttemptAt: new Date(Date.now() - 1) });
    expect(await publisher.publishPending()).toBe(pending);
    expect(await pendingOutbox()).toBe(0);
    // mesmo MessageDeduplicationId: a FIFO entrega uma vez; fora da janela de 5 min, o consumidor deduplica por eventId
    expect(await queues.drain('events')).toHaveLength(pending);
  });

  test('SQS fora do ar: o lote entra no backoff (attempts e nextAttemptAt), nada é perdido', async () => {
    const broken = await createApp({ ...queues.env, queues: { ...queues.env.queues, events: 'fila-que-nao-existe.fifo' } });
    broken.useLogger(false);
    await broken.init();
    try {
      while ((await app.get(OutboxPublisher).publishPending()) > 0); // só os eventos deste teste ficam pendentes
      const wallet = await api.openWallet(url, '100.00');
      expect(await broken.get(OutboxPublisher).publishPending()).toBe(0);
      const retried = await db().find(OutboxMessageEntity, { aggregateId: wallet.id });
      expect(retried.length).toBeGreaterThan(0);
      expect(retried.every((m) => m.attempts === 1 && m.nextAttemptAt! > new Date())).toBe(true);
    } finally {
      await broken.close();
    }
  });

  test('SQS pendurado (aceita a conexão e nunca responde): o publisher desiste no prazo e solta o lote', async () => {
    // queda real: o socket abre e nada volta — fila inexistente erra na hora e não exercita o timeout
    const blackhole = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
    const hung = await createApp({ ...queues.env, awsEndpointUrl: `http://127.0.0.1:${blackhole.port}` });
    hung.useLogger(false);
    await hung.init();
    try {
      while ((await app.get(OutboxPublisher).publishPending()) > 0);
      const wallet = await api.openWallet(url, '100.00');
      const started = Date.now();
      expect(await hung.get(OutboxPublisher).publishPending()).toBe(0);
      expect(Date.now() - started).toBeLessThan(SQS_TIMEOUT_MS + 2_000);
      const retried = await db().find(OutboxMessageEntity, { aggregateId: wallet.id });
      expect(retried.length).toBeGreaterThan(0);
      expect(retried.every((m) => m.attempts === 1 && m.publishedAt === null && m.nextAttemptAt! > new Date())).toBe(true);
    } finally {
      await hung.close();
      blackhole.stop(true);
    }
  }, SQS_TIMEOUT_MS + 15_000);
});

describe('referência fora de ordem (§7.1)', () => {
  const resolver = () => app.get(ResolvePendingReferences);

  test('REFUND pela fila antes da BET: fica PENDING_REFERENCE e o worker aplica quando a BET chega', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const bet = api.wagerPayload(wallet, 'BET', '30.00');
    const refund = wagerData(wallet, 'REFUND', '30.00', { referenceExternalTransactionId: bet.externalTransactionId });
    await queues.sendWager(refund);

    await poll();
    expect((await transactionOf(refund)).status).toBe('PENDING_REFERENCE');
    expect(await queues.drain('wager')).toEqual([]); // desfecho gravado → ack

    expect((await api.send(url, bet)).body.status).toBe('PROCESSED');
    expect(await balance(wallet.id)).toBe('70.00');
    await resolver().runOnce();

    const resolved = await transactionOf(refund);
    expect(resolved).toMatchObject({ status: 'PROCESSED', observedBalance: '100.00', referenceAttempts: 1, nextReferenceAttemptAt: null });
    expect(await balance(wallet.id)).toBe('100.00');
    expect(await db().count(OutboxMessageEntity, { aggregateId: wallet.id, eventType: 'WagerTransactionProcessed' })).toBe(3); // abertura, BET, REFUND
    // replay da REFUND devolve o desfecho atual
    const replay = await api.send(url, refund, refund.idempotencyKey);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', idempotentReplay: true, balance: { amount: '100.00' } });
    expect(await api.reconcile(url, wallet.id)).toMatchObject({ consistent: true });
  });

  test('erro transitório (lock timeout) adia a linha sem gastar tentativa e não trava as outras', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const refund = api.wagerPayload(wallet, 'REFUND', '5.00', { referenceExternalTransactionId: 'ainda-nao' });
    expect((await api.send(url, refund)).status).toBe(202);
    const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    const lock = spyOn(WagerRepository.prototype, 'lockWallet').mockRejectedValueOnce(lockTimeout);
    try {
      await resolver().runOnce();
    } finally {
      lock.mockRestore();
    }
    const row = await transactionOf(refund);
    expect(row).toMatchObject({ status: 'PENDING_REFERENCE', referenceAttempts: 0 });
    expect(row.nextReferenceAttemptAt.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  test('erro que não é transitório (bug) gasta tentativa; esgotadas, FAILED INTERNAL_ERROR + evento, sem mexer no saldo', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const refund = api.wagerPayload(wallet, 'REFUND', '5.00', { referenceExternalTransactionId: 'bug-no-caminho' });
    const sent = await api.send(url, refund);
    expect(sent.status).toBe(202);
    const find = spyOn(WagerRepository.prototype, 'findByExternalId').mockRejectedValue(new Error('bug: coluna inesperada'));
    try {
      await resolver().runOnce();
      const retried = await transactionOf(refund);
      expect(retried).toMatchObject({ status: 'PENDING_REFERENCE', referenceAttempts: 1 });
      expect(retried.nextReferenceAttemptAt!.getTime()).toBeGreaterThan(Date.now());

      await db().nativeUpdate(WagerTransactionEntity, { id: retried.id }, {
        referenceAttempts: MAX_REFERENCE_ATTEMPTS - 1, nextReferenceAttemptAt: new Date(Date.now() - 1),
      });
      await resolver().runOnce();
    } finally {
      find.mockRestore();
    }
    const failed = await transactionOf(refund);
    expect(failed).toMatchObject({ status: 'FAILED', failureCode: 'INTERNAL_ERROR', referenceAttempts: MAX_REFERENCE_ATTEMPTS, nextReferenceAttemptAt: null });
    const events = await db().find(OutboxMessageEntity, { aggregateId: wallet.id, eventType: 'WagerTransactionFailed' });
    expect(events).toHaveLength(1);
    // o evento do worker leva o correlationId de quem enviou a transação, não o id da transação
    expect(events[0]!.payload).toMatchObject({ correlationId: failed.correlationId, data: { status: 'FAILED', failureCode: 'INTERNAL_ERROR' } });
    expect(failed.correlationId).not.toBe(failed.id);
    // terminal: o replay devolve o desfecho (422, não reenvie; 500 fica só para bug) e o worker não pega mais
    const replayed = await api.send(url, refund);
    expect(replayed.status).toBe(422);
    expect(replayed.body).toMatchObject({ status: 'FAILED', failureCode: 'INTERNAL_ERROR', idempotentReplay: true });
    expect(await balance(wallet.id)).toBe('100.00');
  });

  test('sem referência: backoff a cada tentativa e, esgotado o limite, REJECTED REFERENCE_NOT_FOUND + evento', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const rollback = api.wagerPayload(wallet, 'ROLLBACK', '5.00', { referenceExternalTransactionId: 'nunca-chega' });
    expect((await api.send(url, rollback)).status).toBe(202);

    await resolver().runOnce();
    const retried = await transactionOf(rollback);
    expect(retried).toMatchObject({ status: 'PENDING_REFERENCE', referenceAttempts: 1 });
    expect(retried.nextReferenceAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    await resolver().runOnce(); // ainda não venceu: não mexe
    expect((await transactionOf(rollback)).referenceAttempts).toBe(1);

    // pula para a última tentativa
    await db().nativeUpdate(WagerTransactionEntity, { id: retried.id }, {
      referenceAttempts: MAX_REFERENCE_ATTEMPTS - 1, nextReferenceAttemptAt: new Date(Date.now() - 1),
    });
    await resolver().runOnce();

    expect(await transactionOf(rollback)).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    expect(await db().count(OutboxMessageEntity, { aggregateId: wallet.id, eventType: 'WagerTransactionRejected' })).toBe(1);
    expect((await api.send(url, rollback)).body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND' });
    expect(await balance(wallet.id)).toBe('100.00');
  });

  test('instâncias concorrentes reservam lotes disjuntos (SKIP LOCKED) e a reserva segura a linha depois do commit', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const refund = api.wagerPayload(wallet, 'REFUND', '1.00', { referenceExternalTransactionId: `falta-${randomUUID()}` });
      expect((await api.send(url, refund)).status).toBe(202);
      ids.push((await transactionOf(refund)).id);
    }
    const now = new Date();
    const until = new Date(now.getTime() + 60_000);
    const mine = (rows: { id: string }[]) => rows.map((r) => r.id).filter((id) => ids.includes(id));

    let second: string[] = [];
    const first = await orm.em.fork().transactional(async (em) => {
      const claimed = mine(await new WagerRepository(em).claimDuePendingReferences(now, until, 1_000));
      // outra "instância" reserva enquanto a primeira ainda não commitou: pula as linhas travadas
      second = mine(await new WagerRepository(orm.em.fork()).claimDuePendingReferences(now, until, 1_000));
      return claimed;
    });
    expect(first.sort()).toEqual([...ids].sort());
    expect(second).toEqual([]);
    // já commitada: a reserva empurrou a próxima tentativa, ninguém pega de novo antes de `until`
    expect(mine(await new WagerRepository(orm.em.fork()).claimDuePendingReferences(new Date(), until, 1_000))).toEqual([]);
    for (const id of ids) {
      expect(await db().findOneOrFail(WagerTransactionEntity, { id })).toMatchObject({ referenceAttempts: 0, nextReferenceAttemptAt: until });
    }
  });

  test('replay de uma transação ainda pendente devolve o saldo da primeira resposta, mesmo depois de o worker tentar', async () => {
    const wallet = await api.openWallet(url, '100.00');
    const refund = api.wagerPayload(wallet, 'REFUND', '5.00', { referenceExternalTransactionId: 'ainda-nao-chegou' });
    expect((await api.send(url, refund)).body.balance.amount).toBe('100.00');
    await api.send(url, api.wagerPayload(wallet, 'BET', '30.00')); // saldo muda para 70.00
    await resolver().runOnce(); // tenta, a referência continua faltando
    expect(await transactionOf(refund)).toMatchObject({ status: 'PENDING_REFERENCE', referenceAttempts: 1 });
    expect((await api.send(url, refund)).body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' }, idempotentReplay: true });
  });
});

test('invariante final: saldo == ledger em todas as wallets da suíte', async () => {
  expect(await walletsDivergingFromLedger(orm)).toEqual([]);
});
