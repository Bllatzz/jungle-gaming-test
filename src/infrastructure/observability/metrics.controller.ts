import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ENV, type Env } from '../../config/env';
import { SqsGateway } from '../messaging/sqs.gateway';
import { WagerQueries } from '../persistence/wager.queries';
import { Metrics } from './metrics';

const GAUGE_TIMEOUT_MS = 2000;

/** Scrape do Prometheus, sem autenticação (como os health checks). Dependência fora: omite o gauge, nunca 500. */
@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: Metrics,
    private readonly queries: WagerQueries,
    private readonly sqs: SqsGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    const [outbox, dlq] = await Promise.all([
      withTimeout(this.queries.outboxStats()),
      withTimeout(this.sqs.approximateDepth(this.env.queues.wagerDlq, AbortSignal.timeout(GAUGE_TIMEOUT_MS))),
    ]);
    return this.metrics.render([
      ...(outbox
        ? [
            { name: 'outbox_pending_messages', help: 'Eventos da outbox ainda não publicados', value: outbox.pending },
            { name: 'outbox_lag_seconds', help: 'Idade do evento pendente mais antigo (0 = nada pendente)', value: outbox.lagSeconds },
          ]
        : []),
      ...(dlq !== undefined ? [{ name: 'sqs_dlq_messages', help: 'Mensagens na DLQ de entrada (aproximado)', value: dlq }] : []),
    ]);
  }
}

async function withTimeout<T>(promise: Promise<T>): Promise<T | undefined> {
  let timer: Parameters<typeof clearTimeout>[0];
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, GAUGE_TIMEOUT_MS); });
  return Promise.race([promise.catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}
