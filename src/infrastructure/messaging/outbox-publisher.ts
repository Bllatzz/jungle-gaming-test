import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import type { OutboxMessage } from '../../domain/outbox-message';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { Metrics } from '../observability/metrics';
import { WagerRepository } from '../persistence/wager.repository';
import { SqsGateway } from './sqs.gateway';

const BATCH = 10; // limite do SendMessageBatch
/** O lote fica travado no banco durante a chamada: SQS lento não segura a conexão indefinidamente. */
export const SQS_TIMEOUT_MS = 10_000;

/**
 * Publica a outbox na fila de eventos. Cada volta trava um lote com SKIP LOCKED (publishers em outras
 * instâncias pegam outros lotes), publica e grava publishedAt/retry no mesmo commit.
 * Se morrer depois de publicar e antes do commit, o lote volta e é publicado de novo: duplicata segura,
 * porque o evento tem eventId fixo (MessageDeduplicationId na FIFO e chave de dedupe do consumidor).
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
    const { published, retried } = await this.orm.em.fork().transactional(async (em) => {
      const repo = new WagerRepository(em);
      const now = new Date();
      const messages = await repo.claimDueOutbox(now, BATCH);
      if (messages.length === 0) return { published: 0, retried: 0 };

      let failed: Set<string>;
      try {
        const abortSignal = AbortSignal.timeout(SQS_TIMEOUT_MS);
        // o SDK no Bun não derruba o socket pendurado no abort (a chamada ficava ~30 s): o prazo vale pelo race.
        // Se a chamada abandonada ainda publicar, o retry gera duplicata segura (mesmo MessageDeduplicationId).
        const timedOut = new Promise<never>((_, reject) => {
          abortSignal.addEventListener('abort', () => reject(new Error(`SQS não respondeu em ${SQS_TIMEOUT_MS} ms`)), { once: true });
        });
        timedOut.catch(() => {}); // a chamada terminou antes: sem "unhandled rejection"
        const result = await Promise.race([timedOut, this.send(messages, abortSignal)]);
        // só as recusadas voltam: as aceitas já estão na fila, marcá-las de novo só geraria duplicata
        failed = new Set((result.Failed ?? []).map((f) => f.Id!));
      } catch (error) {
        // SQS fora: o lote inteiro entra no backoff em vez de ser tentado em loop
        this.logger.warn({ msg: 'outbox publish failed', error: (error as Error).message, count: messages.length });
        failed = new Set(messages.map((m) => m.id));
      }

      const done = new Date(); // backoff conta do fim da chamada: um SQS lento não deixa o retry já vencido
      for (const m of messages) failed.has(m.id) ? m.scheduleRetry(done) : m.markPublished(done);
      await repo.saveOutbox(messages);
      return { published: messages.length - failed.size, retried: failed.size };
    });
    if (retried > 0) this.metrics.inc('wager_retries_total', { component: 'outbox' }, retried); // só depois do commit
    return published;
  }

  private async send(messages: OutboxMessage[], abortSignal: AbortSignal) {
    const QueueUrl = await this.sqs.queueUrl(this.env.queues.events, abortSignal);
    return this.sqs.client.send(new SendMessageBatchCommand({
      QueueUrl,
      Entries: messages.map((m) => ({
        Id: m.id,
        MessageBody: JSON.stringify(m.payload),
        MessageGroupId: m.aggregateId, // agrupa por wallet (ordem é melhor esforço: ARCHITECTURE.md)
        MessageDeduplicationId: m.id,
        MessageAttributes: { eventType: { DataType: 'String', StringValue: m.eventType } },
      })),
    }), { abortSignal });
  }
}
