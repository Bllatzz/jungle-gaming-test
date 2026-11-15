import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';
import { flushTracing } from '../../src/infrastructure/observability/tracing';
import * as api from '../support/api-client';
import { freshTestDatabase } from '../support/test-database';

/**
 * Diferenciais contra os serviços reais do compose (perfis `auth` e `observability`), não contra dublês:
 * tokens emitidos pelo Keycloak e traces exportados por OTLP para o Jaeger. `bun run test:e2e` sobe os dois.
 */
const KEYCLOAK = 'http://localhost:8180/realms/wagering';
const JAEGER = 'http://localhost:16686';
let app: INestApplication;
let url: string;

beforeAll(async () => {
  const env = await freshTestDatabase('e2e', true);
  app = await createApp({
    ...env,
    auth: { issuer: KEYCLOAK, jwksUrl: `${KEYCLOAK}/protocol/openid-connect/certs` },
    otelEndpoint: 'http://localhost:4318',
  });
  app.useLogger(false);
  await app.listen(0);
  url = await app.getUrl();
});
afterAll(async () => {
  await app?.close();
});

/** client_credentials do client do provedor, no realm importado de docker/keycloak/wagering-realm.json. */
async function tokenFor(provider: string): Promise<string> {
  const res = await fetch(`${KEYCLOAK}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: provider, client_secret: `${provider}-secret` }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}
const asProvider = async (provider: string) => ({ authorization: `Bearer ${await tokenFor(provider)}` });
const openWallet = async (headers: Record<string, string>) => {
  const res = await api.call(url, 'POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }, headers);
  expect(res.status).toBe(201);
  return res.body as api.TestWallet;
};

describe('Keycloak real', () => {
  test('token do provedor passa; sem token → 401; token de outro provedor → 403', async () => {
    const a = await asProvider('provider-a');
    const wallet = await openWallet(a);
    const payload = api.wagerPayload(wallet, 'BET', '10.00'); // providerId: provider-a
    const key = { 'idempotency-key': `${payload.providerId}:${payload.externalTransactionId}` };

    expect((await api.call(url, 'POST', '/wagering/transactions', payload, key)).status).toBe(401);
    expect((await api.call(url, 'POST', '/wagering/transactions', payload, { ...key, ...(await asProvider('provider-b')) })).status).toBe(403);
    const ok = await api.call(url, 'POST', '/wagering/transactions', payload, { ...key, ...a });
    expect(ok.status).toBe(200);
    expect(ok.body.balance.amount).toBe('90.00');
  });

  test('o token do Keycloak carrega o aud que o guard exige (mapper de audience do realm)', async () => {
    const [, body] = (await tokenFor('provider-a')).split('.');
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString());
    expect([claims.aud].flat()).toContain('wagering-api');
    expect(claims.provider_id).toBe('provider-a');
  });
});

describe('Jaeger real', () => {
  test('o span da requisição chega ao Jaeger por OTLP, no trace do traceparent do cliente', async () => {
    const traceId = randomUUID().replace(/-/g, '');
    const wallet = await openWallet({ ...(await asProvider('provider-a')), traceparent: `00-${traceId}-00f067aa0ba902b7-01` });
    expect(wallet.id).toBeDefined();
    await flushTracing();

    let spans: { operationName: string }[] = [];
    for (const deadline = Date.now() + 15_000; spans.length === 0 && Date.now() < deadline; await Bun.sleep(500)) {
      const res = await fetch(`${JAEGER}/api/traces/${traceId}`);
      if (res.ok) spans = ((await res.json()) as { data: { spans: { operationName: string }[] }[] }).data[0]?.spans ?? [];
    }
    expect(spans.map((s) => s.operationName)).toContain('HTTP POST /wallets');
  }, 30_000);
});
