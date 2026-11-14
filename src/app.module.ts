import { MikroOrmModule } from '@mikro-orm/nestjs';
import { type DynamicModule, Module } from '@nestjs/common';
import { ENV, type Env } from './config/env';
import { SqsGateway } from './infrastructure/messaging/sqs.gateway';
import { HealthController } from './infrastructure/observability/health.controller';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';

@Module({})
export class AppModule {
  /** Recebe a config pronta, para que testes subam o app com outra config. */
  static register(env: Env): DynamicModule {
    return {
      module: AppModule,
      imports: [MikroOrmModule.forRoot(createOrmConfig(env))],
      controllers: [HealthController],
      providers: [{ provide: ENV, useValue: env }, SqsGateway],
    };
  }
}
