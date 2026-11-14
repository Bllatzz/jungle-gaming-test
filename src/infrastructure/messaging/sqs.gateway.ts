import { GetQueueAttributesCommand, GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';

/** Cliente SQS compartilhado + resolução preguiçosa das URLs das filas. */
@Injectable()
export class SqsGateway implements OnApplicationShutdown {
  readonly client: SQSClient;
  private readonly urls = new Map<string, string>();

  constructor(@Inject(ENV) env: Env) {
    this.client = new SQSClient({
      region: env.awsRegion,
      endpoint: env.awsEndpointUrl,
      credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey },
      // sem isso uma conexão pendurada trava o consumer (e o SIGTERM) para sempre; 30s > long poll de até 20s
      // throwOnRequestTimeout: sem ele o SDK só loga um aviso e a chamada continua pendurada
      requestHandler: { connectionTimeout: 2_000, requestTimeout: 30_000, throwOnRequestTimeout: true },
    });
  }

  /** Resolve na primeira chamada e guarda; falha não é guardada (a próxima tenta de novo). */
  async queueUrl(name: string, abortSignal?: AbortSignal): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: name }), { abortSignal });
    if (!QueueUrl) throw new Error(`Fila não encontrada: ${name}`);
    this.urls.set(name, QueueUrl);
    return QueueUrl;
  }

  /** Chamada real ao SQS a cada vez (não usa só o cache de URL). Usada pelo readiness. */
  async assertReachable(name: string, abortSignal?: AbortSignal): Promise<void> {
    const QueueUrl = await this.queueUrl(name, abortSignal);
    await this.client.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }), { abortSignal });
  }

  /** ApproximateNumberOfMessages da fila (para as métricas). */
  async approximateDepth(name: string, abortSignal?: AbortSignal): Promise<number> {
    const QueueUrl = await this.queueUrl(name, abortSignal);
    const { Attributes } = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }), { abortSignal });
    return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
  }

  onApplicationShutdown(): void {
    this.client.destroy(); // fecha os sockets keep-alive do SDK
  }
}
