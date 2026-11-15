import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ENV, type Env } from './config/env';
import { SqsGateway } from './infrastructure/messaging/sqs.gateway';
import { HealthController } from './infrastructure/observability/health.controller';
import { Metrics } from './infrastructure/observability/metrics';
import { MetricsController } from './infrastructure/observability/metrics.controller';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { WagerQueries } from './infrastructure/persistence/wager.queries';
import { WagerTransactionsController } from './infrastructure/http/wager-transactions.controller';
import { WalletsController } from './infrastructure/http/wallets.controller';
import { OpenWallet } from './application/open-wallet';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { ReconcileWallet } from './application/reconcile-wallet';
import { ResolvePendingReferences } from './application/resolve-pending-references';
import { OutboxPublisher } from './infrastructure/messaging/outbox-publisher';
import { WagerConsumer } from './infrastructure/messaging/wager-consumer';
import { Workers } from './infrastructure/workers/workers';
import { MetricsRecorder, ReconciliationSource, UnitOfWork } from './application/ports';
import { MikroUnitOfWork } from './infrastructure/persistence/unit-of-work';
import { stopTracing } from './infrastructure/observability/tracing';

@Module({})
export class AppModule implements OnApplicationShutdown {
  /** Exporta os spans pendentes antes de o processo sair (no-op com o tracing desligado). */
  async onApplicationShutdown(): Promise<void> {
    await stopTracing();
  }

  /** Recebe a config pronta, para que testes subam o app com outra config. */
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(createOrmConfig(env))],
      controllers: [HealthController, MetricsController, WalletsController, WagerTransactionsController],
      providers: [
        { provide: ENV, useValue: env },
        SqsGateway,
        Metrics,
        WagerQueries,
        // portas da aplicação → adaptadores da infraestrutura
        { provide: UnitOfWork, useClass: MikroUnitOfWork },
        { provide: MetricsRecorder, useExisting: Metrics },
        { provide: ReconciliationSource, useExisting: WagerQueries },
        // use cases sem decorators do Nest: montados aqui, cada um com o seu Logger
        { provide: OpenWallet, useFactory: (uow: UnitOfWork) => new OpenWallet(uow), inject: [UnitOfWork] },
        {
          provide: ProcessWagerTransaction, inject: [UnitOfWork, MetricsRecorder],
          useFactory: (uow: UnitOfWork, m: MetricsRecorder) => new ProcessWagerTransaction(uow, m, new Logger(ProcessWagerTransaction.name)),
        },
        {
          provide: ResolvePendingReferences, inject: [UnitOfWork, MetricsRecorder],
          useFactory: (uow: UnitOfWork, m: MetricsRecorder) => new ResolvePendingReferences(uow, m, new Logger(ResolvePendingReferences.name)),
        },
        {
          provide: ReconcileWallet, inject: [ReconciliationSource, MetricsRecorder],
          useFactory: (q: ReconciliationSource, m: MetricsRecorder) => new ReconcileWallet(q, m, new Logger(ReconcileWallet.name)),
        },
        WagerConsumer,
        OutboxPublisher,
        Workers,
      ],
    };
  }
}
