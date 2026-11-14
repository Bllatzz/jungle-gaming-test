import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import type { Env } from './config/env';

export async function createApp(env: Env): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(env));
  app.enableShutdownHooks(); // SIGTERM fecha o app de forma ordenada (consumer na parte 5)
  return app;
}
