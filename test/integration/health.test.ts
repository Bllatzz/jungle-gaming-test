import { afterEach, expect, test } from 'bun:test';
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';
import { type Env, loadEnv } from '../../src/config/env';

let app: INestApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** Sobe um app real (porta aleatória) com a config do .env, sobrescrita onde o teste quiser. */
async function start(overrides: Partial<Env> = {}): Promise<string> {
  app = await createApp({ ...loadEnv(process.env), ...overrides });
  app.useLogger(false);
  await app.listen(0);
  return app.getUrl();
}

test('live → 200', async () => {
  const res = await fetch(`${await start()}/health/live`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok' });
});

test('ready → 200 com tudo de pé', async () => {
  const res = await fetch(`${await start()}/health/ready`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
});

test('ready → 503 quando Postgres inacessível, e o app não cai', async () => {
  const url = await start({ databaseUrl: 'postgres://wagering:wagering@localhost:1/wagering' });
  const res = await fetch(`${url}/health/ready`);
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ status: 'error', checks: { postgres: 'down', sqs: 'up' } });
  expect((await fetch(`${url}/health/live`)).status).toBe(200);
});

test('ready → 503 quando SQS inacessível, em menos de 3s', async () => {
  const url = await start({ awsEndpointUrl: 'http://localhost:1' });
  const startedAt = performance.now();
  const res = await fetch(`${url}/health/ready`);
  const elapsedMs = performance.now() - startedAt;
  expect(res.status).toBe(503);
  expect((await res.json()).checks.sqs).toBe('down');
  expect(elapsedMs).toBeLessThan(3000);
});

/** Servidor TCP que aceita conexões e nunca responde: simula dependência pendurada. */
function hangingServer() {
  return Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
}

test('ready → 503 em menos de 3s quando SQS aceita conexão mas não responde (timeout)', async () => {
  const hang = hangingServer();
  try {
    const url = await start({ awsEndpointUrl: `http://127.0.0.1:${hang.port}` });
    const startedAt = performance.now();
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(503);
    expect((await res.json()).checks).toEqual({ postgres: 'up', sqs: 'down' });
    expect(performance.now() - startedAt).toBeLessThan(3000);
  } finally {
    hang.stop(true);
  }
});

test('ready → 503 em menos de 3s quando Postgres aceita conexão mas não responde (timeout)', async () => {
  const hang = hangingServer();
  try {
    const url = await start({ databaseUrl: `postgres://wagering:wagering@127.0.0.1:${hang.port}/wagering` });
    const startedAt = performance.now();
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(503);
    expect((await res.json()).checks).toEqual({ postgres: 'down', sqs: 'up' });
    expect(performance.now() - startedAt).toBeLessThan(3000);
  } finally {
    hang.stop(true);
  }
});

test('ready → 503 quando a fila de eventos (outbox) não existe', async () => {
  const env = loadEnv(process.env);
  const url = await start({ queues: { ...env.queues, events: `inexistente-${crypto.randomUUID()}.fifo` } });
  const res = await fetch(`${url}/health/ready`);
  expect(res.status).toBe(503);
  expect((await res.json()).checks.sqs).toBe('down');
});

test('ready detecta SQS caindo depois de já ter respondido "up" (não usa só o cache)', async () => {
  const env = loadEnv(process.env);
  const sqs = new SQSClient({
    region: env.awsRegion,
    endpoint: env.awsEndpointUrl,
    credentials: { accessKeyId: env.awsAccessKeyId, secretAccessKey: env.awsSecretAccessKey },
  });
  const name = `health-probe-${crypto.randomUUID()}.fifo`;
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true' } }));
  try {
    const url = await start({ queues: { ...env.queues, wager: name } });
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    await sqs.send(new DeleteQueueCommand({ QueueUrl }));
    expect((await fetch(`${url}/health/ready`)).status).toBe(503);
  } finally {
    await sqs.send(new DeleteQueueCommand({ QueueUrl })).catch(() => {}); // já apagada no caminho feliz
    sqs.destroy();
  }
});
