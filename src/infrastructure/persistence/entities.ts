import { defineEntity, type InferEntity, p } from '@mikro-orm/core';
import { FailureCode } from '../../domain/failure-codes';
import { LedgerDirection } from '../../domain/ledger-entry';
import { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';

// Linhas planas, espelho das tabelas da migration. O domínio não conhece o ORM:
// mappers.ts converte linha ↔ objeto de domínio. Colunas em snake_case pela naming strategy padrão.
// Dinheiro: decimal em modo 'string' — nunca passa por number.

export const WalletEntity = defineEntity({
  name: 'WalletRow',
  tableName: 'wallets',
  properties: {
    id: p.uuid().primary(),
    playerId: p.text(),
    currency: p.string().columnType('char(3)'),
    balance: p.decimal('string').precision(20).scale(2),
    version: p.integer(),
    createdAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});
export type WalletRow = InferEntity<typeof WalletEntity>;

export const WagerTransactionEntity = defineEntity({
  name: 'WagerTransactionRow',
  tableName: 'wager_transactions',
  properties: {
    id: p.uuid().primary(),
    providerId: p.text(),
    externalTransactionId: p.text(),
    idempotencyKey: p.text(),
    payloadHash: p.text(),
    walletId: p.uuid(),
    playerId: p.text(),
    roundId: p.text(),
    gameId: p.text(),
    kind: p.enum(() => WagerTransactionKind),
    amount: p.decimal('string').precision(20).scale(2),
    currency: p.string().columnType('char(3)'),
    referenceExternalTransactionId: p.text().nullable(),
    referenceTransactionId: p.uuid().nullable(),
    status: p.enum(() => WagerTransactionStatus),
    failureCode: p.enum(() => FailureCode).nullable(),
    createdAt: p.datetime(),
    processedAt: p.datetime().nullable(),
    observedBalance: p.decimal('string').precision(20).scale(2).nullable(),
    referenceAttempts: p.integer().default(0),
    nextReferenceAttemptAt: p.datetime().nullable(),
  },
});
export type WagerTransactionRow = InferEntity<typeof WagerTransactionEntity>;

export const LedgerEntryEntity = defineEntity({
  name: 'LedgerEntryRow',
  tableName: 'wallet_ledger_entries',
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid(),
    transactionId: p.uuid(),
    direction: p.enum(() => LedgerDirection),
    amount: p.decimal('string').precision(20).scale(2),
    currency: p.string().columnType('char(3)'),
    balanceBefore: p.decimal('string').precision(20).scale(2),
    balanceAfter: p.decimal('string').precision(20).scale(2),
    walletVersion: p.integer(),
    createdAt: p.datetime(),
  },
});
export type LedgerEntryRow = InferEntity<typeof LedgerEntryEntity>;

export const InboxMessageEntity = defineEntity({
  name: 'InboxMessageRow',
  tableName: 'inbox_messages',
  properties: {
    consumerName: p.text().primary(),
    messageId: p.text().primary(),
    payloadHash: p.text(),
    receivedAt: p.datetime(),
    processedAt: p.datetime().nullable(),
  },
});
export type InboxMessageRow = InferEntity<typeof InboxMessageEntity>;

export const OutboxMessageEntity = defineEntity({
  name: 'OutboxMessageRow',
  tableName: 'outbox_messages',
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.text(),
    eventType: p.text(),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime(),
    attempts: p.integer().default(0),
    nextAttemptAt: p.datetime().nullable(),
    publishedAt: p.datetime().nullable(),
  },
});
export type OutboxMessageRow = InferEntity<typeof OutboxMessageEntity>;

export const entities = [WalletEntity, WagerTransactionEntity, LedgerEntryEntity, InboxMessageEntity, OutboxMessageEntity];
