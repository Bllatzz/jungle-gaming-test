import {
  CreateQueueCommand, DeleteMessageBatchCommand, DeleteQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../src/config/env';

/**
 * Filas FIFO só desta execução da suíte (nome único: nada sobra de outra execução nem do dev).
 * Mesma forma das filas do init-sqs.sh, com visibilidade curta para a redelivery não demorar.
 */
export async function freshTestQueues(env: Env, suite: string, visibilityTimeout = 2) {
  const sqs = new SQSClient({
    region: env.awsRegion,
    endpoint: env.awsEndpointUrl,
    credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey },
  });
  const prefix = `test-${suite}-${Date.now()}`;
  const create = async (name: string, attributes: Record<string, string> = {}) =>
    (await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...attributes } }))).QueueUrl!;

  const names = { wager: `${prefix}-wager.fifo`, wagerDlq: `${prefix}-dlq.fifo`, events: `${prefix}-events.fifo` };
  const dlqUrl = await create(names.wagerDlq);
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ['QueueArn'] }));
  const urls = {
    wager: await create(names.wager, {
      VisibilityTimeout: String(visibilityTimeout),
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: '100' }),
    }),
    wagerDlq: dlqUrl,
    events: await create(names.events),
  };

  /** Envelope do §10 com o payload de transação do teste. */
  const sendWager = (data: Record<string, unknown>, messageId = randomUUID(), body?: string) =>
    sqs.send(new SendMessageCommand({
      QueueUrl: urls.wager,
      MessageBody: body ?? JSON.stringify({ messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data }),
      MessageGroupId: String(data.walletId ?? 'g'),
      MessageDeduplicationId: randomUUID(), // dedup do broker fora do caminho: o teste quer a redelivery
    }));

  /** Consome a fila: lê e apaga (na FIFO, o resto de um grupo só aparece depois que as anteriores saem). */
  const drain = async (queue: keyof typeof urls, waitSeconds = 1): Promise<Message[]> => {
    const all: Message[] = [];
    for (;;) {
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: urls[queue], MaxNumberOfMessages: 10, WaitTimeSeconds: waitSeconds, VisibilityTimeout: 30,
        MessageAttributeNames: ['All'], MessageSystemAttributeNames: ['All'],
      }));
      if (Messages.length === 0) return all;
      all.push(...Messages);
      await sqs.send(new DeleteMessageBatchCommand({
        QueueUrl: urls[queue], Entries: Messages.map((m, i) => ({ Id: String(i), ReceiptHandle: m.ReceiptHandle })),
      }));
    }
  };

  const cleanup = async () => {
    await Promise.all(Object.values(urls).map((QueueUrl) => sqs.send(new DeleteQueueCommand({ QueueUrl }))));
    sqs.destroy();
  };

  return { sqs, names, urls, sendWager, drain, cleanup, env: { ...env, queues: names } as Env };
}
