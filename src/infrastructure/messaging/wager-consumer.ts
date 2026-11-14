import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, type Message, ReceiveMessageCommand, SendMessageCommand,
} from '@aws-sdk/client-sqs';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConflictError, NotFoundError } from '../../application/errors';
import { ProcessWagerTransaction, type WagerCommand, type WagerResult } from '../../application/process-wager-transaction';
import { ENV, type Env } from '../../config/env';
import { InvalidMoneyError, InvalidTransactionError } from '../../domain/errors';
import { InvalidRequestError, parseWagerCommand, text } from '../http/request-parsing';
import { Metrics } from '../observability/metrics';
import { isTransient } from '../persistence/transient-errors';
import { SqsGateway } from './sqs.gateway';

export const CONSUMER_NAME = 'wager-transactions-consumer';
/**
 * Recebimentos antes da DLQ, contados pelo app. A redrive policy da fila (maxReceiveCount 10) é só rede de
 * segurança: mensagens devolvidas sem processar (shutdown, wallet bloqueada no lote) também contam recebimento.
 */
export const MAX_RECEIVES = 5;
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
  ) {}

  /** Uma volta: recebe um lote e processa em ordem. Devolve quantas mensagens recebeu. */
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
      }),
      { abortSignal: signal },
    );

    const receivedAt = Date.now();
    const blockedGroups = new Set<string>();
    for (const [i, message] of Messages.entries()) {
      // shutdown, ou lote demorado: devolve o resto antes que a visibilidade vença com ele em andamento
      if (signal.aborted || Date.now() - receivedAt > BATCH_BUDGET_MS) {
        await this.release(QueueUrl, Messages.slice(i));
        break;
      }
      const group = message.Attributes?.MessageGroupId ?? '';
      // FIFO: depois de uma falha, as seguintes da mesma wallet esperam (não passam na frente)
      if (blockedGroups.has(group)) {
        await this.release(QueueUrl, [message]);
        continue;
      }
      const outcome = await this.handle(QueueUrl, message).catch((error: unknown) => {
        // SQS falhou ao mandar para a DLQ ou ao mudar a visibilidade: a mensagem volta sozinha depois
        this.logger.error({ msg: 'message handling failed', sqsMessageId: message.MessageId, error: (error as Error).message });
        return 'retry' as const;
      });
      if (outcome === 'retry') blockedGroups.add(group);
    }
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
    try {
      const { messageId, command } = parseEnvelope(message.Body);
      Object.assign(log, { messageId, correlationId: messageId, walletId: command.walletId, providerId: command.providerId });
      const result = await this.processWager.execute(
        command,
        { correlationId: messageId, causationId: messageId },
        { consumerName: CONSUMER_NAME, messageId },
      );
      processed = { messageId, result };
    } catch (error) {
      const permanent = permanentErrorCode(error);
      if (permanent || receiveCount >= MAX_RECEIVES) {
        const code = permanent ?? (isTransient(error) ? 'RETRIES_EXHAUSTED' : 'PROCESSING_FAILED');
        await this.deadLetter(QueueUrl, message, code);
        this.metrics.inc('sqs_dead_lettered_total', { error_code: code });
        this.logger.warn({ msg: 'message dead-lettered', ...log, errorCode: code, error: (error as Error).message });
        return 'dead-lettered';
      }
      // transitório (ou bug): volta depois de 1s, 2s, 4s… — o SQS conta os recebimentos
      const delay = Math.min(2 ** (receiveCount - 1), MAX_BACKOFF_SECONDS);
      await this.setVisibility(QueueUrl, message, delay);
      this.metrics.inc('wager_retries_total', { component: 'sqs_consumer' });
      this.logger.warn({ msg: 'message retry scheduled', ...log, delaySeconds: delay, transient: isTransient(error), error: (error as Error).message });
      return 'retry';
    }

    // ack só depois do commit. Se falhar (ou o processo morrer aqui), a redelivery cai no inbox/replay:
    // nunca é tratado como falha de processamento — a mensagem já está aplicada.
    const { result } = processed;
    await this.delete(QueueUrl, message).catch(async (error: unknown) => {
      this.logger.warn({ msg: 'ack failed after commit', ...log, error: (error as Error).message });
      await this.setVisibility(QueueUrl, message, 0).catch(() => undefined); // volta já e cai no replay
    });
    this.logger.log({ msg: 'message processed', ...log, transactionId: result.transactionId, status: result.status, replay: result.idempotentReplay });
    return 'acked';
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
