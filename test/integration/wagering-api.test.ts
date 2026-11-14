import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/bootstrap';
import type { Env } from '../../src/config/env';
import { LedgerEntryEntity, OutboxMessageEntity, WagerTransactionEntity } from '../../src/infrastructure/persistence/entities';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import * as api from '../support/api-client';
import { freshTestDatabase, walletsDivergingFromLedger } from '../support/test-database';

let app: INestApplication;
let orm: MikroORM;
let url: string;
let env: Env;

beforeAll(async () => {
  env = await freshTestDatabase('api', true);
  app = await createApp(env);
  app.useLogger(false);
  await app.listen(0);
  url = await app.getUrl();
  orm = await MikroORM.init(createOrmConfig(env));
});
afterAll(async () => {
  await app.close();
  await orm.close();
});

// Atalhos do cliente compartilhado (test/support/api-client.ts) apontando para o app deste arquivo.
const call = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => api.call(url, method, path, body, headers);
const openWallet = (amount?: string) => api.openWallet(url, amount);
const send = async (payload: Record<string, any>, key?: string) => ({ ...(await api.send(url, payload, key)), payload });
const submit = (wallet: api.TestWallet, kind: string, amount: string, extra?: Record<string, unknown>) =>
  send(api.wagerPayload(wallet, kind, amount, extra));

describe('wallets', () => {
  test('abre com saldo inicial: version 1, transação OPENING e lançamento CREDIT', async () => {
    const res = await call('POST', '/wallets', { playerId: 'player-x', initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ playerId: 'player-x', balance: { amount: '1000.00', currency: 'BRL' }, version: 1 });
    const ledger = await call('GET', `/wallets/${res.body.id}/ledger`);
    expect(ledger.body.items).toHaveLength(1);
    expect(ledger.body.items[0]).toMatchObject({ direction: 'CREDIT', money: { amount: '1000.00' }, walletVersion: 1 });
  });

  test('saldo inicial zero: sem transação, sem lançamento', async () => {
    const wallet = await openWallet('0.00');
    expect((await call('GET', `/wallets/${wallet.id}/ledger`)).body.items).toEqual([]);
  });

  test('mesma wallet para o mesmo player + moeda → 409', async () => {
    const wallet = await openWallet();
    const dup = await call('POST', '/wallets', { playerId: wallet.playerId, initialBalance: { amount: '1.00', currency: 'BRL' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('WALLET_ALREADY_EXISTS');
  });

  test('payload inválido → 400', async () => {
    for (const body of [{}, { playerId: 'p', initialBalance: { amount: '1.001', currency: 'BRL' } }, { playerId: 'p', initialBalance: { amount: 10, currency: 'BRL' } }]) {
      expect((await call('POST', '/wallets', body)).status).toBe(400);
    }
  });

  test('wallet inexistente → 404; id malformado → 400', async () => {
    expect((await call('GET', `/wallets/${randomUUID()}`)).status).toBe(404);
    expect((await call('GET', '/wallets/nao-e-uuid')).status).toBe(400);
  });
});

describe('POST /wagering/transactions', () => {
  test('BET processada → 200 com o saldo novo', async () => {
    const wallet = await openWallet();
    const res = await submit(wallet, 'BET', '25.00');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '75.00', currency: 'BRL' }, idempotentReplay: false });
  });

  test('replay idêntico → mesma resposta com idempotentReplay: true, sem novo débito', async () => {
    const wallet = await openWallet();
    const first = await submit(wallet, 'BET', '25.00');
    // "25.0" e "25.00" são o mesmo payload (hash canônico normaliza o dinheiro)
    const again = await send({ ...first.payload, money: { amount: '25.0', currency: 'BRL' } });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ...first.body, idempotentReplay: true });
    expect((await call('GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('75.00');
  });

  test('regra 7: replay devolve o saldo daquele momento, não o atual', async () => {
    const wallet = await openWallet();
    const loss = await submit(wallet, 'LOSS', '0.00');
    expect(loss.body.balance.amount).toBe('100.00');
    await submit(wallet, 'BET', '40.00');
    const replay = await send(loss.payload);
    expect(replay.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' }, idempotentReplay: true });
  });

  test('mesma key com payload diferente → 409, não replay', async () => {
    const wallet = await openWallet();
    const first = await submit(wallet, 'BET', '25.00');
    const conflict = await send({ ...first.payload, money: { amount: '30.00', currency: 'BRL' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('mesmo id externo com outra key → 409', async () => {
    const wallet = await openWallet();
    const first = await submit(wallet, 'BET', '25.00');
    expect((await send(first.payload, 'outra-key')).status).toBe(409);
  });

  test('saldo insuficiente → 422 REJECTED, sem lançamento, auditável e com replay', async () => {
    const wallet = await openWallet();
    const res = await submit(wallet, 'BET', '100.01');
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: { amount: '100.00' } });
    expect(await orm.em.fork().count(LedgerEntryEntity, { transactionId: res.body.transactionId })).toBe(0);
    const replay = await send(res.payload);
    expect(replay.status).toBe(422);
    expect(replay.body.idempotentReplay).toBe(true);
  });

  test('moeda diferente da wallet → 422 CURRENCY_MISMATCH', async () => {
    const wallet = await openWallet();
    const res = await submit(wallet, 'BET', '1.00', { money: { amount: '1.00', currency: 'USD' } });
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('CURRENCY_MISMATCH');
  });

  test('REFUND antes da BET → 202 PENDING_REFERENCE', async () => {
    const wallet = await openWallet();
    const res = await submit(wallet, 'REFUND', '10.00', { referenceExternalTransactionId: 'bet-que-ainda-nao-chegou' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'PENDING_REFERENCE', balance: { amount: '100.00' } });
  });

  test('BET → WIN → REFUND → ROLLBACK do WIN: saldo e ledger batem', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet, 'BET', '30.00');
    const ref = { referenceExternalTransactionId: bet.payload.externalTransactionId };
    const win = await submit(wallet, 'WIN', '50.00', ref);
    expect(win.body.balance.amount).toBe('120.00');
    await submit(wallet, 'REFUND', '30.00', ref);
    const rollback = await submit(wallet, 'ROLLBACK', '50.00', { referenceExternalTransactionId: win.payload.externalTransactionId });
    expect(rollback.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '100.00' } });
    const rec = await call('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(rec.status).toBe(200);
    expect(rec.body).toMatchObject({ consistent: true, checkedEntries: 5, difference: { amount: '0.00' } });
  });

  test('outbox: eventos gravados na mesma transação, um por fato', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet, 'BET', '10.00');
    const loss = await submit(wallet, 'LOSS', '0.00');
    const rejected = await submit(wallet, 'BET', '999.00');
    const types = async (transactionId: string) =>
      (await orm.em.fork().find(OutboxMessageEntity, { aggregateId: wallet.id }))
        .filter((m) => (m.payload as any).data.transactionId === transactionId)
        .map((m) => m.eventType)
        .sort();
    expect(await types(bet.body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
    expect(await types(loss.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect(await types(rejected.body.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  test('entradas inválidas → 400', async () => {
    const wallet = await openWallet();
    const base = {
      providerId: 'provider-a', externalTransactionId: 'x', playerId: wallet.playerId, walletId: wallet.id,
      roundId: 'r', gameId: 'g', kind: 'BET', money: { amount: '1.00', currency: 'BRL' },
    };
    expect((await call('POST', '/wagering/transactions', base)).status).toBe(400); // sem Idempotency-Key
    for (const body of [
      { ...base, kind: 'OPENING' },
      { ...base, kind: 'JACKPOT' },
      { ...base, providerId: 'internal' },
      { ...base, providerId: 'Internal' },
      { ...base, externalTransactionId: ' x' }, // espaço na ponta furaria a deduplicação
      { ...base, money: { amount: '-1.00', currency: 'BRL' } },
      { ...base, walletId: 'nao-e-uuid' },
      { ...base, kind: 'REFUND' }, // REFUND sem referência
    ]) {
      expect((await send(body, 'k')).status).toBe(400);
    }
  });

  test('wallet inexistente → 404', async () => {
    const res = await submit({ id: randomUUID(), playerId: 'p' }, 'BET', '1.00');
    expect(res.status).toBe(404);
  });
});

describe('falhas transitórias → 503 + Retry-After', () => {
  test('wallet travada por mais que o lock_timeout (5s)', async () => {
    const wallet = await openWallet();
    // outra transação segura o lock da wallet enquanto a requisição tenta processar
    const holder = orm.em.fork();
    await holder.begin();
    await holder.getConnection().execute('select 1 from wallets where id = ? for update', [wallet.id], 'all', holder.getTransactionContext());
    try {
      const res = await submit(wallet, 'BET', '1.00');
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('1');
      expect(res.body.error).toBe('TEMPORARILY_UNAVAILABLE');
    } finally {
      await holder.rollback();
    }
    // nada foi gravado: o reenvio processa normalmente
    expect((await submit(wallet, 'BET', '1.00')).status).toBe(200);
  }, 15_000);

  test('Postgres fora do ar', async () => {
    const down = await createApp({ ...env, databaseUrl: 'postgres://wagering:wagering@localhost:1/wagering' });
    down.useLogger(false);
    await down.listen(0);
    try {
      const res = await api.send(await down.getUrl(), api.wagerPayload({ id: randomUUID(), playerId: 'p' }, 'BET', '1.00'));
      expect(res.status).toBe(503);
    } finally {
      await down.close();
    }
  });
});

describe('consultas', () => {
  test('transação por id e por (provider, id externo), com o saldo observado', async () => {
    const wallet = await openWallet();
    const bet = await submit(wallet, 'BET', '10.00');
    const byId = await call('GET', `/wagering/transactions/${bet.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toMatchObject({ kind: 'BET', status: 'PROCESSED', money: { amount: '10.00' }, balance: { amount: '90.00' } });
    const byExternal = await call('GET', `/providers/provider-a/wagering/transactions/${bet.payload.externalTransactionId}`);
    expect(byExternal.body).toEqual(byId.body);
    expect((await call('GET', `/wagering/transactions/${randomUUID()}`)).status).toBe(404);
  });

  test('ledger paginado por cursor estável', async () => {
    const wallet = await openWallet();
    for (let i = 0; i < 4; i++) await submit(wallet, 'BET', '1.00');
    const page1 = await call('GET', `/wallets/${wallet.id}/ledger?limit=2`);
    const page2 = await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${page1.body.nextCursor}`);
    const page3 = await call('GET', `/wallets/${wallet.id}/ledger?limit=2&cursor=${page2.body.nextCursor}`);
    const versions = [...page1.body.items, ...page2.body.items, ...page3.body.items].map((e: any) => e.walletVersion);
    expect(versions).toEqual([1, 2, 3, 4, 5]);
    expect(page3.body.nextCursor).toBeNull();
    expect((await call('GET', `/wallets/${wallet.id}/ledger?cursor=lixo`)).status).toBe(400);
    const huge = Buffer.from('99999999999').toString('base64url'); // não cabe no integer do Postgres
    expect((await call('GET', `/wallets/${wallet.id}/ledger?cursor=${huge}`)).status).toBe(400);
    expect((await call('GET', `/wallets/${wallet.id}/ledger?limit=0`)).status).toBe(400);
  });

  test('reconciliação sinaliza divergência sem corrigir', async () => {
    const wallet = await openWallet();
    // adultera o saldo por fora (o ledger é imutável; a wallet não)
    await orm.em.getConnection().execute(`update wallets set balance = 90 where id = ?`, [wallet.id]);
    const rec = await call('POST', `/wallets/${wallet.id}/reconciliation`);
    expect(rec.body).toMatchObject({
      consistent: false, storedBalance: { amount: '90.00' }, calculatedBalance: { amount: '100.00' }, difference: { amount: '-10.00' },
    });
    expect((await call('GET', `/wallets/${wallet.id}`)).body.balance.amount).toBe('90.00');
  });

  test('cada transação gravada tem o status coerente com o ledger', async () => {
    // sanidade final da suíte: nenhuma transação não-PROCESSED tem lançamento
    const conn = orm.em.getConnection();
    const [row] = await conn.execute(
      `select count(*)::int as n from wallet_ledger_entries l join wager_transactions t on t.id = l.transaction_id where t.status <> 'PROCESSED'`,
    );
    expect(row.n).toBe(0);
    expect(await orm.em.fork().count(WagerTransactionEntity, { observedBalance: null, status: { $in: [WagerTransactionStatus.Processed, WagerTransactionStatus.Rejected] } })).toBe(0);
  });

  test('invariante final: saldo == ledger em todas as wallets da suíte (exceto a adulterada de propósito)', async () => {
    expect(await walletsDivergingFromLedger(orm)).toEqual([{ id: expect.any(String), balance: '90.00' }]);
  });
});
