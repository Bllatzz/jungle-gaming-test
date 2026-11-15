import { expect, test } from 'bun:test';
import { loadEnv } from '../../src/config/env';

const valid = {
  PORT: '3000',
  DATABASE_URL: 'postgres://u:p@h:5432/db',
  AWS_REGION: 'us-east-1',
  AWS_ENDPOINT_URL: 'http://localhost:4566',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_WAGER_QUEUE: 'wager-transactions.fifo',
  SQS_WAGER_DLQ: 'wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE: 'wallet-events.fifo',
};

test('carrega env válida', () => {
  const env = loadEnv(valid);
  expect(env.port).toBe(3000);
  expect(env.queues.wager).toBe('wager-transactions.fifo');
  expect(env.workersEnabled).toBe(true);
  expect(loadEnv({ ...valid, WORKERS_ENABLED: 'false' }).workersEnabled).toBe(false);
  for (const WORKERS_ENABLED of ['FALSE', '0', 'no']) expect(() => loadEnv({ ...valid, WORKERS_ENABLED })).toThrow('WORKERS_ENABLED');
});

test('falha nomeando a variável ausente', () => {
  const { DATABASE_URL: _, ...rest } = valid;
  expect(() => loadEnv(rest)).toThrow('DATABASE_URL');
});

test('trata string vazia ou só com espaços como ausente', () => {
  expect(() => loadEnv({ ...valid, SQS_EVENTS_QUEUE: '' })).toThrow('SQS_EVENTS_QUEUE');
  expect(() => loadEnv({ ...valid, DATABASE_URL: '   ' })).toThrow('DATABASE_URL');
});

test('PORT precisa ser inteiro entre 1 e 65535', () => {
  for (const PORT of ['abc', ' ', '0', '70000', '3000.5']) {
    expect(() => loadEnv({ ...valid, PORT })).toThrow('PORT');
  }
});

test('auth: AUTH_ISSUER e AUTH_JWKS_URL juntas ligam, nenhuma desliga, só uma é erro', () => {
  expect(loadEnv(valid).auth).toBeUndefined();
  const auth = { AUTH_ISSUER: 'http://localhost:8080/realms/wagering', AUTH_JWKS_URL: 'http://keycloak:8080/certs' };
  expect(loadEnv({ ...valid, ...auth }).auth).toEqual({ issuer: auth.AUTH_ISSUER, jwksUrl: auth.AUTH_JWKS_URL });
  expect(() => loadEnv({ ...valid, AUTH_ISSUER: auth.AUTH_ISSUER })).toThrow('AUTH_JWKS_URL');
  expect(() => loadEnv({ ...valid, AUTH_JWKS_URL: auth.AUTH_JWKS_URL })).toThrow('AUTH_ISSUER');
});

test('FAULT_INJECTION só aceita kill-after-commit (ponto de falha dos testes de crash)', () => {
  expect(loadEnv(valid).faultInjection).toBeUndefined();
  expect(loadEnv({ ...valid, FAULT_INJECTION: 'kill-after-commit' }).faultInjection).toBe('kill-after-commit');
  expect(() => loadEnv({ ...valid, FAULT_INJECTION: 'outra' })).toThrow('FAULT_INJECTION');
});
