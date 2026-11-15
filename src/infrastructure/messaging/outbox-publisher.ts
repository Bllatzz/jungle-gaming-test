import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/core';
import type { OutboxMessage } from '../../domain/outbox-message';
import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { Metrics } from '../observability/metrics';
import { inSpan } from '../observability/tracing';
import { WagerRepository } from '../persistence/wager.repository';
import { SqsGateway } from './sqs.gateway';

const BATCH = 10; // limite do SendMessageBatch
/**
 * Eventos reservados por volta, publicados em lotes de BATCH (em paralelo entre wallets, em série dentro de uma): uma reserva e uma gravação no banco
 * para cada 50 eventos, não para cada 10 — sob carga o publisher disputa o pool com o HTTP, e cada ida ao
 * banco a menos encurta o outbox lag.
 */
const CLAIM = 50;
/** SQS lento não segura a volta do publisher indefinidamente (nem a reserva do lote). */
export const SQS_TIMEOUT_MS = 10_000;
/**
 * ORM com pool próprio e pequeno, só do publisher: sob saturação do HTTP o outbox lag não fica esperando
 * conexão no pool principal (e o publisher não toma conexões do HTTP).
 */
export const OUTBOX_ORM = Symbol('OUTBOX_ORM');
export const OUTBOX_POOL = { min: 0, max: 2 };
/** Reserva do lote: maior que a chamada ao SQS mais a gravação do resultado. Vencida, outro publisher pega. */
const LEASE_MS = 30_000;

/**
 * Publica a outbox na fila de eventos, em três passos curtos:
 * 1. reserva um lote (SKIP LOCKED + lease em next_attempt_at) e commita: nenhum lock nem conexão fica preso
 *    enquanto o SQS responde;
 * 2. publica, fora de transação;
 * 3. grava publishedAt/retry, só se a reserva ainda for dele.
 * Se morrer entre 2 e 3, a reserva vence e o lote sai de novo: duplicata segura, porque o evento tem eventId
 * fixo (MessageDeduplicationId na FIFO e chave de dedupe do consumidor).
 */
@Injectable()
export class OutboxPublisher implements OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    @Inject(OUTBOX_ORM) private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: Metrics,
  ) {}

  /** Depois do beforeApplicationShutdown dos Workers: nenhuma volta em andamento usa mais o pool. */
  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }

  /** Uma volta. Devolve quantos eventos publicou. */
  async publishPending(): Promise<number> {
    const now = new Date();
    const leasedUntil = new Date(now.getTime() + LEASE_MS);
    const claimed = await this.orm.em.fork().transactional((em) => new WagerRepository(em).claimDueOutbox(now, leasedUntil, CLAIM));
    if (claimed.length === 0) return 0;
    const messages = claimed.map((c) => c.message);

    let failed: Set<string>;
    try {
      const abortSignal = AbortSignal.timeout(SQS_TIMEOUT_MS);
      // o SDK no Bun não derruba o socket pendurado no abort (a chamada ficava ~30 s): o prazo vale pelo race.
      // Se a chamada abandonada ainda publicar, o retry gera duplicata segura (mesmo MessageDeduplicationId).
      const timedOut = new Promise<never>((_, reject) => {
        abortSignal.addEventListener('abort', () => reject(new Error(`SQS não respondeu em ${SQS_TIMEOUT_MS} ms`)), { once: true });
      });
      timedOut.catch(() => {}); // a chamada terminou antes: sem "unhandled rejection"
      // eventos de uma wallet ficam juntos e em ordem (sort estável sobre a ordem do claim). Lotes de wallets
      // diferentes saem em paralelo; os que compartilham wallet formam uma "pista" e saem em série, e uma falha
      // segura o resto da pista: a FIFO recebe os eventos de cada wallet na ordem em que foram gravados.
      const byWallet = claimed.toSorted((x, y) => (x.message.aggregateId < y.message.aggregateId ? -1 : x.message.aggregateId > y.message.aggregateId ? 1 : 0));
      const chunks = Array.from({ length: Math.ceil(byWallet.length / BATCH) }, (_, i) => byWallet.slice(i * BATCH, (i + 1) * BATCH));
      const lanes: (typeof chunks)[] = [];
      chunks.forEach((chunk, i) => {
        const continues = i > 0 && chunks[i - 1]!.at(-1)!.message.aggregateId === chunk[0]!.message.aggregateId;
        continues ? lanes.at(-1)!.push(chunk) : lanes.push([chunk]);
      });
      const sentFailed = new Set<string>();
      const sendLane = async (lane: typeof chunks) => {
        for (const [i, chunk] of lane.entries()) {
          const rejected = abortSignal.aborted
            ? chunk.map((c) => c.message.id)
            : await this.send(chunk, abortSignal).then((r) => (r.Failed ?? []).map((f) => f.Id!), () => chunk.map((c) => c.message.id));
          // só as recusadas voltam: as aceitas já estão na fila, marcá-las de novo só geraria duplicata
          rejected.forEach((id) => sentFailed.add(id));
          if (rejected.length > 0) return lane.slice(i + 1).flat().forEach((c) => sentFailed.add(c.message.id));
        }
      };
      await inSpan('outbox.publish', { 'messaging.batch.message_count': String(claimed.length) },
        () => Promise.race([timedOut, Promise.all(lanes.map(sendLane))]));
      failed = sentFailed;
      if (failed.size === messages.length) throw new Error('nenhum lote aceito pelo SQS');
    } catch (error) {
      // SQS fora: o lote inteiro entra no backoff em vez de ser tentado em loop
      this.logger.warn({ msg: 'outbox publish failed', error: (error as Error).message, count: messages.length });
      failed = new Set(messages.map((m) => m.id));
    }

    const done = new Date(); // backoff conta do fim da chamada: um SQS lento não deixa o retry já vencido
    for (const m of messages) failed.has(m.id) ? m.scheduleRetry(done) : m.markPublished(done);
    await this.orm.em.fork().transactional((em) => new WagerRepository(em).saveOutbox(messages, leasedUntil));
    if (failed.size > 0) this.metrics.inc('wager_retries_total', { component: 'outbox' }, failed.size); // só depois do commit
    return messages.length - failed.size;
  }

  private async send(claimed: { message: OutboxMessage; traceparent: string | null }[], abortSignal: AbortSignal) {
    const QueueUrl = await this.sqs.queueUrl(this.env.queues.events, abortSignal);
    return this.sqs.client.send(new SendMessageBatchCommand({
      QueueUrl,
      Entries: claimed.map(({ message: m, traceparent }) => ({
        Id: m.id,
        MessageBody: JSON.stringify(m.payload),
        MessageGroupId: m.aggregateId, // grupo FIFO por wallet: a ordem de envio vale dentro do grupo
        MessageDeduplicationId: m.id,
        MessageAttributes: {
          eventType: { DataType: 'String', StringValue: m.eventType },
          // o consumidor do evento continua o trace da transação que o gerou
          ...(traceparent && { traceparent: { DataType: 'String', StringValue: traceparent } }),
        },
      })),
    }), { abortSignal });
  }
}
