import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Env } from './config/env';
import { ErrorFilter } from './infrastructure/http/error.filter';
import { JsonLogger } from './infrastructure/observability/json-logger';
import { startTracing } from './infrastructure/observability/tracing';
import { TracingInterceptor } from './infrastructure/observability/tracing.interceptor';

export async function createApp(env: Env): Promise<INestApplication> {
  startTracing(env.otelEndpoint); // antes do Nest: os spans do boot em diante já têm provider
  // logs do boot ficam guardados até o logger JSON entrar (testes trocam por useLogger(false))
  const app = await NestFactory.create(AppModule.register(env), { bufferLogs: true });
  app.useLogger(new JsonLogger());
  app.useGlobalFilters(new ErrorFilter());
  app.useGlobalInterceptors(new TracingInterceptor());
  app.enableShutdownHooks(); // SIGTERM: workers terminam a volta atual antes de fechar banco e SQS
  return app;
}
