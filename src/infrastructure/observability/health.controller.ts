import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ENV, type Env } from '../../config/env';
import { SqsGateway } from '../messaging/sqs.gateway';

const CHECK_TIMEOUT_MS = 2000;
type CheckStatus = 'up' | 'down';

/** Health checks sem autenticação (README do desafio, §2 e §9). */
@Controller('health')
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    private readonly sqs: SqsGateway,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Liveness: o processo responde. Não olha dependências (senão o orquestrador mataria o app à toa). */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: Postgres e as 3 filas SQS alcançáveis. 503 se qualquer um falhar. */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const [postgres, sqs] = await Promise.all([
      // select 1 de verdade: checkConnection() só olha conexão já aberta, e o ORM conecta sob demanda.
      check(() => this.orm.em.getConnection().execute('select 1')),
      // As 3 filas: entrada, DLQ e destino da outbox. Qualquer uma faltando = não pronto.
      check((signal) =>
        Promise.all(Object.values(this.env.queues).map((queue) => this.sqs.assertReachable(queue, signal))),
      ),
    ]);
    const ok = postgres === 'up' && sqs === 'up';
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'error', checks: { postgres, sqs } };
  }
}

/**
 * Roda a checagem com timeout: dependência pendurada conta como "down", não trava o endpoint.
 * O signal cancela de fato a chamada ao SQS; o Postgres não aceita signal, por isso o race.
 */
async function check(fn: (signal: AbortSignal) => Promise<unknown>): Promise<CheckStatus> {
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const timedOut = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  timedOut.catch(() => {}); // evita "unhandled rejection" quando a checagem termina antes
  try {
    await Promise.race([fn(signal), timedOut]);
    return 'up';
  } catch {
    return 'down';
  }
}
