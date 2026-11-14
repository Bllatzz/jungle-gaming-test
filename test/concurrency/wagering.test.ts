import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';
import type { Env } from '../../src/config/env';
import { call, openWallet, reconcile, send, wagerPayload, type TestWallet } from '../support/api-client';
import { freshTestDatabase } from '../support/test-database';

// Paralelismo real: requisições HTTP simultâneas, cada uma na sua conexão do pool, contra Postgres real.

let env: Env;
let app: INestApplication;
let url: string;
const bet = (wallet: TestWallet, amount: string) => wagerPayload(wallet, 'BET', amount);

beforeAll(async () => {
  env = await freshTestDatabase('concurrency', true);
  app = await createApp(env);
  app.useLogger(false);
  await app.listen(0);
  url = await app.getUrl();
});
afterAll(() => app.close());

const statuses = (results: { status: number }[]) =>
  results.reduce<Record<number, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});

describe('concorrência na mesma wallet', () => {
  test('a mesma aposta 50 vezes em paralelo → um único débito', async () => {
    const wallet = await openWallet(url, '100.00');
    const payload = bet(wallet, '10.00');
    const results = await Promise.all(Array.from({ length: 50 }, () => send(url, payload)));

    expect(statuses(results)).toEqual({ 200: 50 });
    expect(results.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.transactionId)).size).toBe(1);
    expect(results.every((r) => r.body.balance.amount === '90.00')).toBe(true);
    expect(await reconcile(url, wallet.id)).toMatchObject({ consistent: true, storedBalance: { amount: '90.00' }, checkedEntries: 2 });
  });

  test('cenário obrigatório: 100.00 e duas apostas de 80.00 simultâneas', async () => {
    const wallet = await openWallet(url, '100.00');
    const payloads = [bet(wallet, '80.00'), bet(wallet, '80.00')];
    const results = await Promise.all(payloads.map((p) => send(url, p)));

    expect(results.map((r) => r.body.status).sort()).toEqual(['PROCESSED', 'REJECTED']);
    expect(results.find((r) => r.body.status === 'REJECTED')!.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    // nenhum retry duplica o débito: reenviar as duas devolve as respostas originais
    const retries = await Promise.all(payloads.map((p) => send(url, p)));
    expect(retries.map((r) => ({ ...r.body, idempotentReplay: false }))).toEqual(results.map((r) => r.body));

    const ledger = await call(url, 'GET', `/wallets/${wallet.id}/ledger`);
    expect(ledger.body.items.filter((e: any) => e.direction === 'DEBIT')).toHaveLength(1);
    expect(await reconcile(url, wallet.id)).toMatchObject({ consistent: true, storedBalance: { amount: '20.00' } });
  });

  test('hot wallet: 30 apostas diferentes de 5.00 sobre 100.00 → exatamente 20 passam', async () => {
    const wallet = await openWallet(url, '100.00');
    const results = await Promise.all(Array.from({ length: 30 }, () => send(url, bet(wallet, '5.00'))));
    expect(statuses(results)).toEqual({ 200: 20, 422: 10 });
    expect(await reconcile(url, wallet.id)).toMatchObject({ consistent: true, storedBalance: { amount: '0.00' }, checkedEntries: 21 });
  });
});

test('wallets diferentes em paralelo terminam consistentes', async () => {
  const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet(url, '50.00')));
  const results = await Promise.all(wallets.flatMap((w) => Array.from({ length: 5 }, () => send(url, bet(w, '10.00')))));
  expect(statuses(results)).toEqual({ 200: 50 });
  for (const w of wallets) {
    expect(await reconcile(url, w.id)).toMatchObject({ consistent: true, storedBalance: { amount: '0.00' } });
  }
});

describe('3 instâncias do app ao mesmo tempo', () => {
  const ports = [39101, 39102, 39103];
  let instances: Subprocess[] = [];

  beforeAll(async () => {
    instances = ports.map((port) =>
      Bun.spawn(['bun', join(import.meta.dir, '../../src/main.ts')], {
        env: { ...process.env, PORT: String(port), DATABASE_URL: env.databaseUrl },
        stdout: 'ignore',
        stderr: 'inherit', // se uma instância não subir, o motivo aparece na saída do teste
      }),
    );
    for (const port of ports) await waitUntilLive(`http://localhost:${port}`);
  });
  afterAll(async () => {
    for (const p of instances) p.kill('SIGTERM');
    await Promise.all(instances.map((p) => p.exited));
  });

  test('a mesma wallet disputada pelas 3: sem saldo negativo, sem débito duplicado', async () => {
    const urls = ports.map((p) => `http://localhost:${p}`);
    const wallet = await openWallet(urls[0]!, '100.00');
    // 20 apostas distintas de 10.00, cada uma enviada às 3 instâncias ao mesmo tempo (redelivery simultânea)
    const payloads = Array.from({ length: 20 }, () => bet(wallet, '10.00'));
    const results = await Promise.all(payloads.flatMap((payload) => urls.map((u) => send(u, payload))));

    const firstTime = results.filter((r) => !r.body.idempotentReplay);
    expect(firstTime).toHaveLength(20); // cada aposta decidida uma única vez
    expect(firstTime.filter((r) => r.body.status === 'PROCESSED')).toHaveLength(10);
    expect(firstTime.filter((r) => r.body.status === 'REJECTED')).toHaveLength(10);
    for (const u of urls) {
      expect(await reconcile(u, wallet.id)).toMatchObject({ consistent: true, storedBalance: { amount: '0.00' }, checkedEntries: 11 });
    }
  });
});

async function waitUntilLive(baseUrl: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${baseUrl}/health/live`)).ok) return;
    } catch {
      // ainda subindo
    }
    await Bun.sleep(100);
  }
  throw new Error(`${baseUrl} não subiu`);
}
