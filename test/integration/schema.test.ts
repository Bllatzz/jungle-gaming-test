import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  CheckConstraintViolationException,
  ForeignKeyConstraintViolationException,
  UniqueConstraintViolationException,
} from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { FailureCode } from '../../src/domain/failure-codes';
import { InboxMessage } from '../../src/domain/inbox-message';
import { Money } from '../../src/domain/money';
import { OutboxMessage } from '../../src/domain/outbox-message';
import { applyWager } from '../../src/domain/wager-rules';
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { openWallet } from '../../src/domain/wallet';
import {
  InboxMessageEntity,
  LedgerEntryEntity,
  OutboxMessageEntity,
  WagerTransactionEntity,
  WalletEntity,
} from '../../src/infrastructure/persistence/entities';
import * as map from '../../src/infrastructure/persistence/mappers';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';
import { freshTestDatabase } from '../support/test-database';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
// saldo observado só importa para o replay (parte 4); aqui qualquer valor válido serve
const txRow = (t: WagerTransaction) => map.toWagerTransactionRow(t, brl('100.00'));
let orm: MikroORM;

beforeAll(async () => {
  orm = await MikroORM.init(createOrmConfig(await freshTestDatabase('schema')));
  await orm.migrator.up();
});
afterAll(() => orm.close());

/** Wallet aberta com 100.00 BRL + transação OPENING + lançamento, gravados juntos. */
async function seedWallet() {
  const walletId = randomUUID();
  const { wallet, opening } = openWallet({
    walletId,
    playerId: randomUUID(),
    initialBalance: brl('100.00'),
    openingTransactionId: randomUUID(),
    openingLedgerEntryId: randomUUID(),
    now: NOW,
  });
  await orm.em.fork().transactional(async (em) => {
    await em.insert(WalletEntity, map.toWalletRow(wallet));
    await em.insert(WagerTransactionEntity, txRow(opening!.transaction));
    await em.insert(LedgerEntryEntity, map.toLedgerEntryRow(opening!.ledgerEntry, 1));
  });
  return { wallet, opening: opening! };
}

/** BET de 30.00 aplicada pelas regras do domínio: devolve a wallet, a transação e o lançamento, já gravados. */
async function seedProcessedBet() {
  const { wallet } = await seedWallet();
  const bet = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '30.00');
  const decision = applyWager({
    wallet, transaction: bet, reference: undefined, referenceAlreadyReversedBySameKind: false,
    ledgerEntryId: randomUUID(), now: NOW,
  });
  if (decision.status !== 'PROCESSED' || !decision.ledgerEntry) throw new Error('BET deveria ser processada');
  await orm.em.fork().transactional(async (em) => {
    await em.insert(WagerTransactionEntity, txRow(bet));
    await em.insert(LedgerEntryEntity, map.toLedgerEntryRow(decision.ledgerEntry!, 2));
    await em.nativeUpdate(WalletEntity, { id: wallet.id }, map.toWalletRow(wallet));
  });
  return { wallet, bet, entry: decision.ledgerEntry };
}

function newTransaction(walletId: string, playerId: string, kind: WagerTransactionKind, amount: string, reference?: string) {
  const externalId = randomUUID();
  return WagerTransaction.create({
    id: randomUUID(), providerId: 'provider-a', externalTransactionId: externalId,
    idempotencyKey: `provider-a:${externalId}`, payloadHash: 'hash', walletId, playerId,
    roundId: 'round-1', gameId: 'fortune-chimp', kind, money: brl(amount),
    referenceExternalTransactionId: reference, createdAt: NOW,
  });
}

const insert = (entity: Parameters<MikroORM['em']['insert']>[0], row: object) => orm.em.fork().insert(entity, row);

describe('migration', () => {
  test('desce e sobe de novo sem erro (reversível)', async () => {
    await orm.migrator.down({ to: 0 });
    expect(await orm.em.getConnection().execute(`select to_regclass('wallets') as t`)).toEqual([{ t: null }]);
    await orm.migrator.up();
    expect(await orm.migrator.getPending()).toEqual([]);
  });
});

describe('migration 2 em banco com dados', () => {
  test('preenche wallet_version e observed_balance das linhas antigas', async () => {
    await orm.migrator.down({ to: 'Migration20261114120000' });
    const conn = orm.em.getConnection();
    const [w, t1, t2] = [randomUUID(), randomUUID(), randomUUID()];
    await conn.execute(`insert into wallets values (?, 'p-old', 'BRL', 70, 2, now(), now())`, [w]);
    await conn.execute(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
         player_id, round_id, game_id, kind, amount, currency, status, created_at, processed_at)
       values (?, 'internal', 'o', 'internal:o', '', ?, 'p-old', 'opening', 'opening', 'OPENING', 100, 'BRL', 'PROCESSED', now(), now()),
              (?, 'provider-a', 'b', 'provider-a:b', 'h', ?, 'p-old', 'r', 'g', 'BET', 30, 'BRL', 'PROCESSED', now(), now())`,
      [t1, w, t2, w],
    );
    await conn.execute(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values (?, ?, ?, 'CREDIT', 100, 'BRL', 0, 100, now() - interval '1 minute'), (?, ?, ?, 'DEBIT', 30, 'BRL', 100, 70, now())`,
      [randomUUID(), w, t1, randomUUID(), w, t2],
    );

    await orm.migrator.up();

    const ledger = await conn.execute(`select wallet_version from wallet_ledger_entries where wallet_id = ? order by created_at`, [w]);
    expect(ledger.map((r: any) => r.wallet_version)).toEqual([1, 2]);
    const txs = await conn.execute(`select kind, observed_balance from wager_transactions where wallet_id = ? order by kind`, [w]);
    expect(txs).toEqual([{ kind: 'BET', observed_balance: '70.00' }, { kind: 'OPENING', observed_balance: '100.00' }]);
    // os triggers voltaram a valer depois do preenchimento
    await expect(conn.execute(`update wallet_ledger_entries set wallet_version = 9 where wallet_id = ?`, [w])).rejects.toThrow('append-only');
  });
});

describe('round-trip domínio → linha → domínio', () => {
  test('wallet, transação e lançamento voltam iguais (dinheiro como string, sem number)', async () => {
    const { wallet, bet, entry } = await seedProcessedBet();
    const em = orm.em.fork();

    const walletBack = map.toWallet(await em.findOneOrFail(WalletEntity, wallet.id));
    expect(walletBack.balance.toString()).toBe('70.00');
    expect(walletBack.version).toBe(2);
    expect(map.toWalletRow(walletBack)).toEqual(map.toWalletRow(wallet));

    const betBack = map.toWagerTransaction(await em.findOneOrFail(WagerTransactionEntity, bet.id));
    expect(betBack.toState()).toEqual(bet.toState());

    const entryBack = map.toLedgerEntry(await em.findOneOrFail(LedgerEntryEntity, entry.id));
    expect(entryBack.isBalanced()).toBe(true);
    expect(map.toLedgerEntryRow(entryBack, 2)).toEqual(map.toLedgerEntryRow(entry, 2));
  });

  test('valor no limite de NUMERIC(20,2) não perde precisão', async () => {
    const { wallet } = await seedWallet();
    const big = '999999999999999999.99';
    await orm.em.fork().nativeUpdate(WalletEntity, { id: wallet.id }, { balance: big, version: 2 });
    const row = await orm.em.fork().findOneOrFail(WalletEntity, wallet.id);
    expect(map.toWallet(row).balance.toString()).toBe(big);
  });

  test('inbox e outbox voltam iguais', async () => {
    const inbox = InboxMessage.receive({ messageId: randomUUID(), consumerName: 'wager-consumer', payloadHash: 'h', receivedAt: NOW });
    inbox.markProcessed(NOW);
    const outbox = OutboxMessage.rehydrate({
      id: randomUUID(), aggregateId: randomUUID(), eventType: 'WalletBalanceChanged',
      payload: { eventId: 'e', data: { money: { amount: '1.00', currency: 'BRL' } } }, occurredAt: NOW, attempts: 0,
    });
    outbox.scheduleRetry(NOW); // attempts 1 e nextAttemptAt preenchido: cobre o null ↔ undefined
    await insert(InboxMessageEntity, map.toInboxMessageRow(inbox));
    await insert(OutboxMessageEntity, map.toOutboxMessageRow(outbox));
    const em = orm.em.fork();
    const inboxBack = map.toInboxMessage(await em.findOneOrFail(InboxMessageEntity, { consumerName: 'wager-consumer', messageId: inbox.messageId }));
    expect(map.toInboxMessageRow(inboxBack)).toEqual(map.toInboxMessageRow(inbox));
    const outboxBack = map.toOutboxMessage(await em.findOneOrFail(OutboxMessageEntity, outbox.id));
    expect(map.toOutboxMessageRow(outboxBack)).toEqual(map.toOutboxMessageRow(outbox));
  });
});

describe('wallets', () => {
  test('uma wallet por player + moeda', async () => {
    const { wallet } = await seedWallet();
    const dup = { ...map.toWalletRow(wallet), id: randomUUID() };
    await expect(insert(WalletEntity, dup)).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    // outra moeda para o mesmo player é permitida
    await insert(WalletEntity, { ...dup, currency: 'USD' });
  });

  test('saldo negativo é recusado pelo banco', async () => {
    const { wallet } = await seedWallet();
    await expect(orm.em.fork().nativeUpdate(WalletEntity, { id: wallet.id }, { balance: '-0.01' }))
      .rejects.toBeInstanceOf(CheckConstraintViolationException);
  });

  test('version menor que 1 é recusada', async () => {
    const { wallet } = await seedWallet();
    await expect(orm.em.fork().nativeUpdate(WalletEntity, { id: wallet.id }, { version: 0 }))
      .rejects.toBeInstanceOf(CheckConstraintViolationException);
  });

  test('moeda fora do formato ISO é recusada', async () => {
    const { wallet } = await seedWallet();
    await expect(insert(WalletEntity, { ...map.toWalletRow(wallet), id: randomUUID(), playerId: randomUUID(), currency: 'br1' }))
      .rejects.toBeInstanceOf(CheckConstraintViolationException);
  });
});

describe('wager_transactions', () => {
  test('mesmo (provider, id externo) duas vezes é recusado', async () => {
    const { bet } = await seedProcessedBet();
    const row = { ...txRow(bet), id: randomUUID(), idempotencyKey: randomUUID() };
    await expect(insert(WagerTransactionEntity, row)).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });

  test('mesma idempotency key do mesmo provider é recusada', async () => {
    const { bet } = await seedProcessedBet();
    const row = { ...txRow(bet), id: randomUUID(), externalTransactionId: randomUUID() };
    await expect(insert(WagerTransactionEntity, row)).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });

  test('REFUND sem referência externa é recusado', async () => {
    const { wallet } = await seedWallet();
    const row = { ...txRow(newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '1.00')), kind: WagerTransactionKind.Refund };
    await expect(insert(WagerTransactionEntity, row)).rejects.toBeInstanceOf(CheckConstraintViolationException);
  });

  test('tentativas do worker de referências não podem ser negativas', async () => {
    const { wallet } = await seedWallet();
    const row = { ...txRow(newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '1.00')), referenceAttempts: -1 };
    await expect(insert(WagerTransactionEntity, row)).rejects.toBeInstanceOf(CheckConstraintViolationException);
  });

  test('valor zero só é aceito em LOSS', async () => {
    const { wallet } = await seedWallet();
    const loss = txRow(newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Loss, '0.00'));
    await insert(WagerTransactionEntity, loss);
    const bet = { ...txRow(newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '1.00')), amount: '0.00' };
    await expect(insert(WagerTransactionEntity, bet)).rejects.toBeInstanceOf(CheckConstraintViolationException);
  });

  test('status e campos coerentes nos dois sentidos (processed_at ⇔ PROCESSED, failure_code ⇔ REJECTED/FAILED)', async () => {
    const { wallet } = await seedWallet();
    const base = () => txRow(newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '1.00'));
    for (const row of [
      { ...base(), status: WagerTransactionStatus.Processed },
      { ...base(), status: WagerTransactionStatus.Rejected },
      { ...base(), processedAt: NOW },
      { ...base(), failureCode: FailureCode.InternalError },
    ]) {
      await expect(insert(WagerTransactionEntity, row)).rejects.toBeInstanceOf(CheckConstraintViolationException);
    }
  });

  test('kind, status, failure_code e moeda fora da lista são recusados', async () => {
    const { wallet } = await seedWallet();
    const base = () => txRow(newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '1.00'));
    for (const row of [
      { ...base(), kind: 'JACKPOT' },
      { ...base(), status: 'DONE' },
      { ...base(), status: WagerTransactionStatus.Rejected, failureCode: 'OOPS' },
      { ...base(), currency: 'br1' },
    ]) {
      await expect(insert(WagerTransactionEntity, row)).rejects.toBeInstanceOf(CheckConstraintViolationException);
    }
  });

  test('transação terminal não muda nem é apagada', async () => {
    const { bet } = await seedProcessedBet();
    await expect(orm.em.fork().nativeUpdate(WagerTransactionEntity, { id: bet.id }, {
      status: WagerTransactionStatus.Rejected, failureCode: FailureCode.InternalError, processedAt: null,
    })).rejects.toThrow('is terminal');
    await expect(orm.em.fork().nativeDelete(WagerTransactionEntity, { id: bet.id })).rejects.toThrow('is terminal');
  });

  test('transação pendente não é apagada nem tem campos do payload alterados', async () => {
    const { wallet } = await seedWallet();
    const pending = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '1.00');
    await insert(WagerTransactionEntity, txRow(pending));
    await expect(orm.em.fork().nativeUpdate(WagerTransactionEntity, { id: pending.id }, { amount: '999.00' }))
      .rejects.toThrow('immutable');
    await expect(orm.em.fork().nativeDelete(WagerTransactionEntity, { id: pending.id })).rejects.toThrow('cannot be deleted');
  });

  test('transação PENDING_REFERENCE pode ser atualizada', async () => {
    const { wallet } = await seedWallet();
    const refund = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Refund, '1.00', 'bet-que-nao-chegou');
    refund.markPendingReference();
    await insert(WagerTransactionEntity, txRow(refund));
    refund.reject(FailureCode.ReferenceNotFound);
    await orm.em.fork().nativeUpdate(WagerTransactionEntity, { id: refund.id }, txRow(refund));
  });

  test('regra 4: a mesma BET não pode ser revertida duas vezes pelo mesmo tipo', async () => {
    const { wallet, bet } = await seedProcessedBet();
    const refund = (id = randomUUID()) => {
      const r = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Refund, '30.00', bet.externalTransactionId);
      r.markProcessed(bet.id, NOW);
      return { ...txRow(r), id };
    };
    await insert(WagerTransactionEntity, refund());
    await expect(insert(WagerTransactionEntity, refund())).rejects.toBeInstanceOf(UniqueConstraintViolationException);

    // regra 4 literal: um ROLLBACK da mesma BET é outro tipo, então o banco aceita (ver ARCHITECTURE.md)
    const rollback = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Rollback, '30.00', bet.externalTransactionId);
    rollback.markProcessed(bet.id, NOW);
    await insert(WagerTransactionEntity, txRow(rollback));
  });

  test('regra 4 não é contornável com referência NULL nem com auto-referência', async () => {
    const { wallet, bet } = await seedProcessedBet();
    const r = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Refund, '30.00', bet.externalTransactionId);
    r.markProcessed(bet.id, NOW);
    const row = txRow(r);
    await expect(insert(WagerTransactionEntity, { ...row, referenceTransactionId: null }))
      .rejects.toBeInstanceOf(CheckConstraintViolationException);
    await expect(insert(WagerTransactionEntity, { ...row, referenceTransactionId: row.id }))
      .rejects.toBeInstanceOf(CheckConstraintViolationException);
  });

  test('rejeição por CURRENCY_MISMATCH fica gravada mesmo com moeda diferente da wallet', async () => {
    const { wallet } = await seedWallet();
    const usd = WagerTransaction.rehydrate({
      ...newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Bet, '1.00').toState(),
      money: Money.from({ amount: '1.00', currency: 'USD' }),
      status: WagerTransactionStatus.Rejected, failureCode: FailureCode.CurrencyMismatch,
    });
    await insert(WagerTransactionEntity, txRow(usd));
  });
});

describe('wallet_ledger_entries', () => {
  test('lançamento não pode ser alterado nem apagado', async () => {
    const { entry } = await seedProcessedBet();
    // muda só a data: nenhum CHECK é violado, então quem recusa é o trigger
    await expect(orm.em.fork().nativeUpdate(LedgerEntryEntity, { id: entry.id }, { createdAt: new Date() }))
      .rejects.toThrow('append-only');
    await expect(orm.em.fork().nativeDelete(LedgerEntryEntity, { id: entry.id })).rejects.toThrow('append-only');
    await expect(orm.em.getConnection().execute('truncate wallet_ledger_entries')).rejects.toThrow('append-only');
  });

  test('no máximo um lançamento por transação', async () => {
    const { entry } = await seedProcessedBet();
    await expect(insert(LedgerEntryEntity, { ...map.toLedgerEntryRow(entry, 2), id: randomUUID() }))
      .rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });

  test('aritmética desbalanceada é recusada', async () => {
    const { wallet } = await seedWallet();
    const tx = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Win, '5.00');
    await insert(WagerTransactionEntity, txRow(tx));
    const row = {
      id: randomUUID(), walletId: wallet.id, transactionId: tx.id, direction: 'CREDIT',
      amount: '5.00', currency: 'BRL', balanceBefore: '100.00', balanceAfter: '106.00', walletVersion: 2, createdAt: NOW,
    };
    await expect(insert(LedgerEntryEntity, row)).rejects.toBeInstanceOf(CheckConstraintViolationException);
    await expect(insert(LedgerEntryEntity, { ...row, direction: 'DEBIT', balanceAfter: '105.00' }))
      .rejects.toBeInstanceOf(CheckConstraintViolationException);
    // aritmética certa, mas saldo final negativo
    await expect(insert(LedgerEntryEntity, { ...row, direction: 'DEBIT', balanceBefore: '3.00', balanceAfter: '-2.00' }))
      .rejects.toBeInstanceOf(CheckConstraintViolationException);
  });

  test('lançamento em moeda diferente da wallet é recusado (FK composta)', async () => {
    const { wallet } = await seedWallet();
    const tx = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Win, '5.00');
    await insert(WagerTransactionEntity, txRow(tx));
    const row = {
      id: randomUUID(), walletId: wallet.id, transactionId: tx.id, direction: 'CREDIT',
      amount: '5.00', currency: 'USD', balanceBefore: '100.00', balanceAfter: '105.00', walletVersion: 2, createdAt: NOW,
    };
    await expect(insert(LedgerEntryEntity, row)).rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
  });
});

describe('wallet_ledger_entries ↔ wager_transactions', () => {
  test('lançamento precisa ter a wallet, o valor e a moeda da sua transação', async () => {
    const { wallet } = await seedWallet();
    const other = (await seedWallet()).wallet;
    const tx = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Win, '5.00');
    await insert(WagerTransactionEntity, txRow(tx));
    const row = {
      id: randomUUID(), walletId: wallet.id, transactionId: tx.id, direction: 'CREDIT',
      amount: '5.00', currency: 'BRL', balanceBefore: '100.00', balanceAfter: '105.00', walletVersion: 2, createdAt: NOW,
    };
    await expect(insert(LedgerEntryEntity, { ...row, walletId: other.id }))
      .rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
    await expect(insert(LedgerEntryEntity, { ...row, amount: '6.00', balanceAfter: '106.00' }))
      .rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
    await insert(LedgerEntryEntity, row);
  });
});

describe('outbox_messages', () => {
  test('attempts negativo é recusado', async () => {
    const row = {
      id: randomUUID(), aggregateId: randomUUID(), eventType: 'X', payload: {}, occurredAt: NOW,
      attempts: -1, nextAttemptAt: null, publishedAt: null,
    };
    await expect(insert(OutboxMessageEntity, row)).rejects.toBeInstanceOf(CheckConstraintViolationException);
  });
});

describe('inbox_messages', () => {
  test('mesma mensagem para o mesmo consumidor é recusada', async () => {
    const row = map.toInboxMessageRow(
      InboxMessage.receive({ messageId: randomUUID(), consumerName: 'wager-consumer', payloadHash: 'h', receivedAt: NOW }),
    );
    await insert(InboxMessageEntity, row);
    await expect(insert(InboxMessageEntity, row)).rejects.toBeInstanceOf(UniqueConstraintViolationException);
    await insert(InboxMessageEntity, { ...row, consumerName: 'outro-consumer' });
  });
});
