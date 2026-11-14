import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import { ENV, type Env } from './config/env';
import { SqsGateway } from './infrastructure/messaging/sqs.gateway';
import { HealthController } from './infrastructure/observability/health.controller';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { WagerQueries } from './infrastructure/persistence/wager.queries';
import { WagerTransactionsController } from './infrastructure/http/wager-transactions.controller';
import { WalletsController } from './infrastructure/http/wallets.controller';
import { OpenWallet } from './application/open-wallet';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import { ReconcileWallet } from './application/reconcile-wallet';

@Module({})
export class AppModule {
  /** Recebe a config pronta, para que testes subam o app com outra config. */
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(createOrmConfig(env))],
      controllers: [HealthController, WalletsController, WagerTransactionsController],
      providers: [
        { provide: ENV, useValue: env },
        SqsGateway,
        WagerQueries,
        ProcessWagerTransaction,
        OpenWallet,
        ReconcileWallet,
      ],
    };
  }
}
