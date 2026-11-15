import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { ServiceUnavailableException, type ExecutionContext, type INestApplication } from '@nestjs/common';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose';
import { createApp } from '../../src/bootstrap';
import type { Env } from '../../src/config/env';
import { AuthGuard } from '../../src/infrastructure/http/auth.guard';
import * as api from '../support/api-client';
import { freshTestDatabase } from '../support/test-database';

/**
 * AuthGuard com JWKS de verdade: um IdP de mentira (Bun.serve) publica a chave pública e os testes assinam
 * tokens RS256 como o Keycloak faria. O que muda do Keycloak real é só quem emite o token.
 */
const ISSUER = 'http://idp.test/realms/wagering';
let app: INestApplication;
let url: string;
let idp: ReturnType<typeof Bun.serve>;
let signingKey: CryptoKey;
let env: Env;

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  signingKey = keys.privateKey;
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  idp = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  env = { ...(await freshTestDatabase('auth', true)), auth: { issuer: ISSUER, jwksUrl: `http://localhost:${idp.port}/certs` } };
  app = await createApp(env);
  app.useLogger(false);
  await app.listen(0);
  url = await app.getUrl();
});
afterAll(async () => {
  await app.close();
  idp.stop(true);
});

async function token(claims: JWTPayload = { provider_id: 'provider-a' }, opts: { issuer?: string; key?: CryptoKey; expiresIn?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '5m')
    .sign(opts.key ?? signingKey);
}
const bearer = async (t: string | Promise<string>) => ({ authorization: `Bearer ${await t}` });
const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => api.call(url, method, path, body, headers);
const openWallet = async () => {
  const res = await call('POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount: '100.00', currency: 'BRL' } }, await bearer(token()));
  expect(res.status).toBe(201);
  return res.body as api.TestWallet;
};
const sendAs = async (provider: string, payload: Record<string, any>) =>
  call('POST', '/wagering/transactions', payload, {
    'idempotency-key': `${payload.providerId}:${payload.externalTransactionId}`,
    ...(await bearer(token({ provider_id: provider }))),
  });

describe('token', () => {
  test('health e métricas ficam abertos', async () => {
    expect((await call('GET', '/health/live')).status).toBe(200);
    expect((await fetch(`${url}/metrics`)).status).toBe(200);
  });

  test('sem token, token malformado, assinado por outra chave, de outro emissor, vencido ou sem provider_id → 401', async () => {
    const other = (await generateKeyPair('RS256')).privateKey;
    const cases: Record<string, string>[] = [
      {},
      { authorization: 'Bearer nao-e-jwt' },
      { authorization: 'Basic dXNlcjpzZW5oYQ==' },
      await bearer(token(undefined, { key: other })),
      await bearer(token(undefined, { issuer: 'http://outro-idp' })),
      await bearer(token(undefined, { expiresIn: '-1m' })),
      await bearer(token({ sub: 'sem-provider' })),
      await bearer(token({ provider_id: '' })),
    ];
    for (const headers of cases) {
      const res = await call('POST', '/wallets', { playerId: 'p', initialBalance: { amount: '1.00', currency: 'BRL' } }, headers);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('UNAUTHENTICATED');
    }
  });

  test('token válido abre wallet e processa transação do próprio provedor', async () => {
    const wallet = await openWallet();
    const res = await sendAs('provider-a', api.wagerPayload(wallet, 'BET', '30.00'));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('PROCESSED');
  });
});

describe('um provedor não age em nome de outro', () => {
  test('transação com providerId diferente do token → 403 e nada é gravado', async () => {
    const wallet = await openWallet();
    const payload = api.wagerPayload(wallet, 'BET', '30.00', { providerId: 'provider-b' });
    const res = await sendAs('provider-a', payload);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_PROVIDER');
    const lookup = await call('GET', `/providers/provider-b/wagering/transactions/${payload.externalTransactionId}`, undefined, await bearer(token({ provider_id: 'provider-b' })));
    expect(lookup.status).toBe(404);
    expect((await call('GET', `/wallets/${wallet.id}`, undefined, await bearer(token()))).body.balance.amount).toBe('100.00');
  });

  test('consulta por id externo de outro provedor → 403; por id interno → 404', async () => {
    const wallet = await openWallet();
    const payload = api.wagerPayload(wallet, 'BET', '10.00');
    const { body } = await sendAs('provider-a', payload);
    const byExternal = `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`;
    const asB = await bearer(token({ provider_id: 'provider-b' }));
    expect((await call('GET', byExternal, undefined, asB)).status).toBe(403);
    expect((await call('GET', `/wagering/transactions/${body.transactionId}`, undefined, asB)).status).toBe(404);
    expect((await call('GET', `/wagering/transactions/${body.transactionId}`, undefined, await bearer(token()))).status).toBe(200);
  });

  test('invariante: saldo == ledger', async () => {
    const wallet = await openWallet();
    await sendAs('provider-a', api.wagerPayload(wallet, 'BET', '40.00'));
    const res = await call('POST', `/wallets/${wallet.id}/reconciliation`, undefined, await bearer(token()));
    expect(res.body.consistent).toBe(true);
    expect(res.body.storedBalance.amount).toBe('60.00');
  });
});

test('IdP fora do ar → 503 (transitório), não 401', async () => {
  const closed = Bun.serve({ port: 0, fetch: () => new Response() });
  const deadUrl = `http://localhost:${closed.port}/certs`;
  closed.stop(true);
  const guard = new AuthGuard({ ...env, auth: { issuer: ISSUER, jwksUrl: deadUrl } });
  const valid = await token();
  const req = { header: () => `Bearer ${valid}`, params: {}, body: {} };
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(ServiceUnavailableException);
});
