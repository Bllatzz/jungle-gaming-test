import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Env } from './config/env';
import { ErrorFilter } from './infrastructure/http/error.filter';

export async function createApp(env: Env): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(env));
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks(); // SIGTERM: workers terminam a volta atual antes de fechar banco e SQS
  return app;
}
