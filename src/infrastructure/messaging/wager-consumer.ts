import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, type Message, ReceiveMessageCommand, SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/core';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../../application/errors';
import { ProcessWagerTransaction, type WagerCommand, type WagerResult } from '../../application/process-wager-transaction';
import { ENV, type Env } from '../../config/env';
import { InvalidMoneyError, InvalidTransactionError } from '../../domain/errors';
import { InvalidRequestError, parseWagerCommand, text } from '../http/request-parsing';
import { Metrics } from '../observability/metrics';
import { annotateWager, inSpan } from '../observability/tracing';
import { isTransient } from '../persistence/transient-errors';
import { SqsGateway } from './sqs.gateway';

export const CONSUMER_NAME = 'wager-transactions-consumer';
/**
 * Falhas de processamento antes da DLQ, contadas pelo app em consumer_message_failures — não pelo
 * ApproximateReceiveCount do SQS, que também sobe quando a mensagem é só devolvida sem processar (shutdown,
 * irmã de grupo bloqueado). Com o banco fora não dá para contar: aí vale o ApproximateReceiveCount.
 * MAX_RECEIVES vale para erro não transitório (bug); erro transitório (banco fora, lock_timeout) tem orçamento
 * próprio, maior: com backoff 1+2+4+8+16+32+60+60 s, a mensagem aguenta ~3 min de queda antes da DLQ — um restart
 * ou failover do Postgres não manda mensagem válida para a DLQ.
 * A redrive policy da fila (maxReceiveCount 10) é só rede de segurança, acima dos dois limites.
 */
export const MAX_RECEIVES = 5;
export const MAX_TRANSIENT_RECEIVES = 9;
const MAX_BACKOFF_SECONDS = 60;
const WAIT_TIME_SECONDS = 10;
/** Visibilidade pedida no receive; o lote para de ser processado antes dela vencer (o resto volta para a fila). */
const VISIBILITY_SECONDS = 30;
const BATCH_BUDGET_MS = 20_000;

type Outcome = 'acked' | 'dead-lettered' | 'retry';

/**
 * Consumer de wager-transactions.fifo. Usa o mesmo use case da entrada HTTP, com inbox na mesma transação.
 * Uma regra só: ack quando o desfecho está no banco (processada, rejeitada, pendente ou replay);
 * DLQ quando nada pode ser gravado (payload inválido, wallet inexistente, conflito); retry quando transitório.
 */
@Injectable()
export class WagerConsumer {
  private readonly logger = new Logger(WagerConsumer.name);
  private readonly abort = new AbortController();

  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly sqs: SqsGateway,
    @Inject(ENV) private readonly env: Env,
    private readonly metrics: Metrics,
    private readonly orm: MikroORM,
  ) {}

  /** Uma volta: recebe um lote e processa cada grupo FIFO em ordem. Devolve quantas mensagens recebeu. */
  async pollOnce(waitTimeSeconds = WAIT_TIME_SECONDS): Promise<number> {
    const signal = this.abort.signal;
    const QueueUrl = await this.sqs.queueUrl(this.env.queues.wager, signal);
    const { Messages = [] } = await this.sqs.client.send(
      new ReceiveMessageCommand({
        QueueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: VISIBILITY_SECONDS,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
        MessageAttributeNames: ['traceparent'],
      }),
      { abortSignal: signal },
    );

    // FIFO só ordena dentro do grupo (wallet): grupos diferentes em paralelo, cada grupo em ordem
    const groups = Map.groupBy(Messages, (m) => m.Attributes?.MessageGroupId ?? '');
    const receivedAt = Date.now();
    await Promise.all([...groups.values()].map(async (group) => {
      for (const [i, message] of group.entries()) {
        // shutdown, ou lote demorado: devolve o resto antes que a visibilidade vença com ele em andamento
        if (signal.aborted || Date.now() - receivedAt > BATCH_BUDGET_MS) return this.release(QueueUrl, group.slice(i));
        const traceparent = message.MessageAttributes?.traceparent?.StringValue;
        const outcome = await inSpan('sqs.process wager-transactions', { 'messaging.message.id': message.MessageId ?? '' },
          () => this.handle(QueueUrl, message), traceparent).catch((error: unknown) => {
          // SQS falhou ao mandar para a DLQ ou ao mudar a visibilidade: a mensagem volta sozinha depois
          this.logger.error({ msg: 'message handling failed', sqsMessageId: message.MessageId, error: (error as Error).message });
          return 'retry' as const;
        });
        // depois de uma falha, as seguintes da mesma wallet esperam (não passam na frente)
        if (outcome === 'retry') return this.release(QueueUrl, group.slice(i + 1));
      }
    }));
    return Messages.length;
  }

  /** SIGTERM: para de receber; a mensagem em andamento termina, as outras do lote voltam para a fila. */
  interrupt(): void {
    this.abort.abort();
  }

  private async handle(QueueUrl: string, message: Message): Promise<Outcome> {
    const receiveCount = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    // log ganha os ids da transação assim que o envelope é lido (retry e DLQ rastreáveis até a wallet)
    const log: Record<string, unknown> = { sqsMessageId: message.MessageId, receiveCount };
    let processed: { messageId: string; result: WagerResult };
    let messageId: string | undefined;
    try {
      const parsed = parseEnvelope(message.Body);
      messageId = parsed.messageId;
      const { command } = parsed;
      Object.assign(log, { messageId, correlationId: messageId, walletId: command.walletId, providerId: command.providerId });
      const result = await this.processWager.execute(
        command,
        { correlationId: messageId, causationId: messageId },
        { consumerName: CONSUMER_NAME, messageId },
      );
      annotateWager(command, result, messageId);
      processed = { messageId, result };
    } catch (error) {
      const permanent = permanentErrorCode(error);
      // permanente não precisa contar; o resto conta a falha desta mensagem (banco fora: vale o receiveCount)
      const failures = permanent || !messageId ? receiveCount : await this.countFailure(messageId).catch(() => receiveCount);
      log.failures = failures;
      if (permanent || failures >= (isTransient(error) ? MAX_TRANSIENT_RECEIVES : MAX_RECEIVES)) {
        const code = permanent ?? (isTransient(error) ? 'RETRIES_EXHAUSTED' : 'PROCESSING_FAILED');
        await this.deadLetter(QueueUrl, message, code);
        if (messageId && !permanent) await this.clearFailures(messageId);
        this.metrics.inc('sqs_dead_lettered_total', { error_code: code });
        this.logger.warn({ msg: 'message dead-lettered', ...log, errorCode: code, error: (error as Error).message });
        return 'dead-lettered';
      }
      // transitório (ou bug): volta depois de 1s, 2s, 4s…
      const delay = Math.min(2 ** (failures - 1), MAX_BACKOFF_SECONDS);
      await this.setVisibility(QueueUrl, message, delay);
      this.metrics.inc('wager_retries_total', { component: 'sqs_consumer' });
      this.logger.warn({ msg: 'message retry scheduled', ...log, delaySeconds: delay, transient: isTransient(error), error: (error as Error).message });
      return 'retry';
    }

    // ack só depois do commit. Se falhar (ou o processo morrer aqui), a redelivery cai no inbox/replay:
    // nunca é tratado como falha de processamento — a mensagem já está aplicada.
    const { result } = processed;
    if (this.env.faultInjection === 'kill-after-commit') process.kill(process.pid, 'SIGKILL'); // teste de crash (env.ts)
    await this.delete(QueueUrl, message).catch(async (error: unknown) => {
      this.logger.warn({ msg: 'ack failed after commit', ...log, error: (error as Error).message });
      await this.setVisibility(QueueUrl, message, 0).catch(() => undefined); // volta já e cai no replay
    });
    if (receiveCount > 1) await this.clearFailures(processed.messageId); // só quem já voltou pode ter falha contada
    this.logger.log({ msg: 'message processed', ...log, transactionId: result.transactionId, status: result.status, replay: result.idempotentReplay });
    return 'acked';
  }

  /** Mais uma falha desta mensagem; devolve o total. Fora de qualquer transação de negócio (aquela foi desfeita). */
  private async countFailure(messageId: string): Promise<number> {
    const [row] = await this.orm.em.fork().getConnection().execute<{ failures: number }[]>(
      `insert into consumer_message_failures (consumer_name, message_id, failures, last_failed_at) values (?, ?, 1, now())
       on conflict (consumer_name, message_id)
       do update set failures = consumer_message_failures.failures + 1, last_failed_at = now()
       returning failures`,
      [CONSUMER_NAME, messageId],
    );
    return row!.failures;
  }

  /** Desfecho definido (ack ou DLQ): a contagem não serve mais. Melhor esforço — uma linha órfã só ocupa espaço. */
  private async clearFailures(messageId: string): Promise<void> {
    await this.orm.em.fork().getConnection()
      .execute('delete from consumer_message_failures where consumer_name = ? and message_id = ?', [CONSUMER_NAME, messageId])
      .catch(() => undefined);
  }

  private async deadLetter(QueueUrl: string, message: Message, errorCode: string): Promise<void> {
    await this.sqs.client.send(new SendMessageCommand({
      QueueUrl: await this.sqs.queueUrl(this.env.queues.wagerDlq),
      MessageBody: message.Body || '(vazio)',
      MessageGroupId: message.Attributes?.MessageGroupId ?? 'unknown',
      MessageDeduplicationId: message.MessageId, // se morrer antes do delete, o reenvio não duplica na DLQ
      MessageAttributes: { errorCode: { DataType: 'String', StringValue: errorCode } },
    }));
    await this.delete(QueueUrl, message);
  }

  private async delete(QueueUrl: string, message: Message): Promise<void> {
    await this.sqs.client.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
  }

  private async setVisibility(QueueUrl: string, message: Message, seconds: number): Promise<void> {
    await this.sqs.client.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle, VisibilityTimeout: seconds }));
  }

  /** Falha ao devolver uma não trava as outras: a que falhou volta sozinha quando a visibilidade vencer. */
  private async release(QueueUrl: string, messages: Message[]): Promise<void> {
    const results = await Promise.allSettled(messages.map((m) => this.setVisibility(QueueUrl, m, 0)));
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) this.logger.warn({ msg: 'message release failed', count: failed });
  }
}

/** Erros que nenhuma nova tentativa resolve. undefined = pode ser transitório. */
function permanentErrorCode(error: unknown): string | undefined {
  if (error instanceof InvalidRequestError) return 'INVALID_MESSAGE';
  if (error instanceof InvalidMoneyError || error instanceof InvalidTransactionError) return error.code;
  if (error instanceof NotFoundError || error instanceof ConflictError) return error.code;
  return undefined;
}

/** Envelope do §10: { messageId, type: "WagerTransactionRequested", occurredAt, data }. */
export function parseEnvelope(body: string | undefined): { messageId: string; command: WagerCommand } {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body ?? '');
  } catch {
    throw new InvalidRequestError('Mensagem não é JSON');
  }
  if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
    throw new InvalidRequestError('Mensagem deve ser um objeto JSON');
  }
  const { messageId, type, data } = envelope as Record<string, unknown>;
  if (type !== 'WagerTransactionRequested') throw new InvalidRequestError(`type desconhecido: ${String(type)}`);
  const idempotencyKey = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).idempotencyKey : undefined;
  return { messageId: text(messageId, 'messageId'), command: parseWagerCommand(data, idempotencyKey) };
}
