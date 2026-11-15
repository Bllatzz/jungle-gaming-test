import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import type { OutboxMessage } from '../../domain/outbox-message';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { Metrics } from '../observability/metrics';
import { inSpan } from '../observability/tracing';
import { WagerRepository } from '../persistence/wager.repository';
import { SqsGateway } from './sqs.gateway';

const BATCH = 10; // limite do SendMessageBatch
/**
 * Eventos reservados por volta, publicados em lotes de BATCH em paralelo: uma reserva e uma gravação no banco
 * para cada 50 eventos, não para cada 10 — sob carga o publisher disputa o pool com o HTTP, e cada ida ao
 * banco a menos encurta o outbox lag.
 */
const CLAIM = 50;
/** SQS lento não segura a volta do publisher indefinidamente (nem a reserva do lote). */
export const SQS_TIMEOUT_MS = 10_000;
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
export class OutboxPublisher {
  private readonly logger = new Logger(OutboxPublisher.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: Metrics,
  ) {}

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
      // ordenação estável por wallet: os eventos de uma wallet ficam juntos e em ordem no mesmo lote (só uma
      // wallet com mais de BATCH eventos numa volta atravessa lotes, que saem em paralelo — ordem é melhor esforço)
      const byWallet = claimed.toSorted((x, y) => (x.message.aggregateId < y.message.aggregateId ? -1 : x.message.aggregateId > y.message.aggregateId ? 1 : 0));
      const chunks = Array.from({ length: Math.ceil(byWallet.length / BATCH) }, (_, i) => byWallet.slice(i * BATCH, (i + 1) * BATCH));
      const results = await inSpan('outbox.publish', { 'messaging.batch.message_count': String(claimed.length) },
        () => Promise.race([timedOut, Promise.allSettled(chunks.map((chunk) => this.send(chunk, abortSignal)))]));
      failed = new Set();
      results.forEach((result, i) => {
        // só as recusadas voltam: as aceitas já estão na fila, marcá-las de novo só geraria duplicata
        if (result.status === 'fulfilled') for (const f of result.value.Failed ?? []) failed.add(f.Id!);
        else for (const { message } of chunks[i]!) failed.add(message.id);
      });
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
        MessageGroupId: m.aggregateId, // agrupa por wallet (ordem é melhor esforço: ARCHITECTURE.md)
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
