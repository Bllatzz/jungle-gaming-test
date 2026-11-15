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
import { LedgerDirection } from '../../src/domain/ledger-entry';
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
    wallet, transaction: bet, reference: undefined, referenceAlreadyReversed: false,
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
    // migration 5: os lançamentos antigos ganham as duas pernas da partida dobrada
    const postings = await conn.execute(
      `select account, direction, amount from ledger_postings where transaction_id in (?, ?) order by amount desc, account`, [t1, t2],
    );
    expect(postings).toEqual([
      { account: 'provider:internal', direction: 'DEBIT', amount: '100.00' },
      { account: `wallet:${w}`, direction: 'CREDIT', amount: '100.00' },
      { account: 'provider:provider-a', direction: 'CREDIT', amount: '30.00' },
      { account: `wallet:${w}`, direction: 'DEBIT', amount: '30.00' },
    ]);
  });
});

describe('saldo == ledger no schema (migration 7)', () => {
  const conn = () => orm.em.fork().getConnection();

  test('saldo alterado sem lançamento é recusado no commit', async () => {
    const { wallet } = await seedWallet();
    await expect(conn().execute(`update wallets set balance = 99 where id = ?`, [wallet.id])).rejects.toThrow('does not match');
    await expect(conn().execute(`update wallets set version = 5 where id = ?`, [wallet.id])).rejects.toThrow('does not match');
  });

  test('wallet nova com saldo e sem lançamento é recusada', async () => {
    const { wallet } = await seedWallet();
    await expect(insert(WalletEntity, { ...map.toWalletRow(wallet), id: randomUUID(), playerId: randomUUID() }))
      .rejects.toThrow('no ledger entries');
  });

  test('lançamento sem atualizar a wallet é recusado no commit', async () => {
    const { wallet } = await seedWallet();
    const win = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Win, '5.00');
    await insert(WagerTransactionEntity, txRow(win));
    await expect(insert(LedgerEntryEntity, {
      id: randomUUID(), walletId: wallet.id, transactionId: win.id, direction: LedgerDirection.Credit, amount: '5.00', currency: 'BRL',
      balanceBefore: '100.00', balanceAfter: '105.00', walletVersion: 2, createdAt: NOW,
    })).rejects.toThrow('does not match');
  });

  test('lançamento que não continua o anterior é recusado, mesmo com a wallet acompanhando', async () => {
    const { wallet } = await seedWallet();
    for (const broken of [
      { balanceBefore: '90.00', balanceAfter: '95.00', walletVersion: 2 }, // não parte do saldo anterior (100.00)
      { balanceBefore: '100.00', balanceAfter: '105.00', walletVersion: 3 }, // pula uma versão
    ]) {
      const win = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Win, '5.00');
      await expect(orm.em.fork().transactional(async (em) => {
        await em.insert(WagerTransactionEntity, txRow(win));
        await em.insert(LedgerEntryEntity, {
          id: randomUUID(), walletId: wallet.id, transactionId: win.id, direction: LedgerDirection.Credit, amount: '5.00', currency: 'BRL',
          createdAt: NOW, ...broken,
        });
        await em.nativeUpdate(WalletEntity, { id: wallet.id }, { balance: broken.balanceAfter, version: broken.walletVersion });
      })).rejects.toThrow('does not continue the chain');
    }
  });
});

describe('wallets: abertura idempotente (migration 6)', () => {
  test('a mesma Idempotency-Key não abre duas wallets, e key sem hash é recusada', async () => {
    const { wallet } = await seedWallet();
    const key = `open-${randomUUID()}`;
    const fresh = () => ({ ...map.toWalletRow(wallet), id: randomUUID(), playerId: randomUUID(), balance: '0.00' });
    await insert(WalletEntity, { ...fresh(), openIdempotencyKey: key, openPayloadHash: 'h' });
    await expect(insert(WalletEntity, { ...fresh(), openIdempotencyKey: key, openPayloadHash: 'h' }))
      .rejects.toBeInstanceOf(UniqueConstraintViolationException);
    await expect(insert(WalletEntity, { ...fresh(), openIdempotencyKey: `outra-${key}`, openPayloadHash: null }))
      .rejects.toBeInstanceOf(CheckConstraintViolationException);
  });
});

describe('ledger_postings (partidas dobradas)', () => {
  const postingsOf = (transactionId: string) =>
    orm.em.fork().getConnection().execute(
      `select account, direction, amount from ledger_postings where transaction_id = ? order by account`, [transactionId],
    );

  test('cada lançamento gera duas pernas: wallet no mesmo sentido, provider no oposto', async () => {
    const { wallet, opening } = await seedWallet();
    expect(await postingsOf(opening.transaction.id)).toEqual([
      { account: 'provider:internal', direction: 'DEBIT', amount: '100.00' },
      { account: `wallet:${wallet.id}`, direction: 'CREDIT', amount: '100.00' },
    ]);
    const { wallet: w2, bet } = await seedProcessedBet();
    expect(await postingsOf(bet.id)).toEqual([
      { account: 'provider:provider-a', direction: 'CREDIT', amount: '30.00' },
      { account: `wallet:${w2.id}`, direction: 'DEBIT', amount: '30.00' },
    ]);
  });

  test('balancete: débitos = créditos no banco inteiro e conta da wallet = saldo da wallet', async () => {
    await seedProcessedBet();
    const conn = orm.em.fork().getConnection();
    const [trial] = await conn.execute(`
      select coalesce(sum(case direction when 'DEBIT' then amount else -amount end), 0)::text as net from ledger_postings`);
    expect(trial).toEqual({ net: '0.00' });
    const diverging = await conn.execute(`
      select w.id from wallets w
        left join ledger_postings p on p.account = 'wallet:' || w.id
       group by w.id
      having w.balance <> coalesce(sum(case p.direction when 'CREDIT' then p.amount else -p.amount end), 0)`);
    expect(diverging).toEqual([]);
  });

  test('partida que não fecha é recusada no commit', async () => {
    const { opening } = await seedWallet();
    await expect(
      orm.em.fork().transactional(async (em) => {
        await em.getConnection().execute(
          `insert into ledger_postings (transaction_id, account, direction, amount, currency, created_at)
           values (?, 'provider:fraude', 'DEBIT', 1, 'BRL', now())`,
          [opening.transaction.id], 'run', em.getTransactionContext(),
        );
      }),
    ).rejects.toThrow('do not balance');
  });

  test('ledger_postings é append-only', async () => {
    const { opening } = await seedWallet();
    const conn = orm.em.fork().getConnection();
    await expect(conn.execute(`update ledger_postings set amount = 1 where transaction_id = ?`, [opening.transaction.id])).rejects.toThrow('append-only');
    await expect(conn.execute(`delete from ledger_postings where transaction_id = ?`, [opening.transaction.id])).rejects.toThrow('append-only');
    await expect(conn.execute(`truncate ledger_postings`)).rejects.toThrow('append-only');
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
    // saldo só muda junto com o lançamento (migration 7): um WIN de 100.00 até o limite
    const win = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Win, '999999999999999899.99');
    await orm.em.fork().transactional(async (em) => {
      await em.insert(WagerTransactionEntity, txRow(win));
      await em.insert(LedgerEntryEntity, {
        id: randomUUID(), walletId: wallet.id, transactionId: win.id, direction: LedgerDirection.Credit, amount: '999999999999999899.99',
        currency: 'BRL', balanceBefore: '100.00', balanceAfter: big, walletVersion: 2, createdAt: NOW,
      });
      await em.nativeUpdate(WalletEntity, { id: wallet.id }, { balance: big, version: 2 });
    });
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
    // outra moeda para o mesmo player é permitida (saldo 0: sem lançamento, o saldo tem que ser 0)
    await insert(WalletEntity, { ...dup, currency: 'USD', balance: '0.00' });
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

  test('regra 4: a mesma BET não pode ser revertida duas vezes, nem pelo mesmo tipo nem por tipo diferente', async () => {
    const { wallet, bet } = await seedProcessedBet();
    const refund = (id = randomUUID()) => {
      const r = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Refund, '30.00', bet.externalTransactionId);
      r.markProcessed(bet.id, NOW);
      return { ...txRow(r), id };
    };
    await insert(WagerTransactionEntity, refund());
    await expect(insert(WagerTransactionEntity, refund())).rejects.toBeInstanceOf(UniqueConstraintViolationException);

    // REFUND + ROLLBACK da mesma BET devolveria a aposta duas vezes (§3: não duplicar créditos)
    const rollback = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Rollback, '30.00', bet.externalTransactionId);
    rollback.markProcessed(bet.id, NOW);
    await expect(insert(WagerTransactionEntity, txRow(rollback))).rejects.toBeInstanceOf(UniqueConstraintViolationException);
  });

  test('regra 2 no banco: referência resolvida é do mesmo provider, player, wallet, moeda e rodada', async () => {
    const { wallet, bet } = await seedProcessedBet();
    const refund = () => {
      const r = newTransaction(wallet.id, wallet.playerId, WagerTransactionKind.Refund, '30.00', bet.externalTransactionId);
      r.markProcessed(bet.id, NOW);
      return txRow(r);
    };
    for (const change of [{ roundId: 'outra-rodada' }, { providerId: 'outro-provider' }, { playerId: 'outro-player' }]) {
      await expect(insert(WagerTransactionEntity, { ...refund(), ...change }))
        .rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
    }
    const { wallet: other } = await seedWallet();
    await expect(insert(WagerTransactionEntity, { ...refund(), walletId: other.id, playerId: other.playerId }))
      .rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
    await insert(WagerTransactionEntity, refund()); // o mesmo contexto passa
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
      id: randomUUID(), walletId: wallet.id, transactionId: tx.id, direction: LedgerDirection.Credit,
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
      id: randomUUID(), walletId: wallet.id, transactionId: tx.id, direction: LedgerDirection.Credit,
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
      id: randomUUID(), walletId: wallet.id, transactionId: tx.id, direction: LedgerDirection.Credit,
      amount: '5.00', currency: 'BRL', balanceBefore: '100.00', balanceAfter: '105.00', walletVersion: 2, createdAt: NOW,
    };
    await expect(insert(LedgerEntryEntity, { ...row, walletId: other.id }))
      .rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
    await expect(insert(LedgerEntryEntity, { ...row, amount: '6.00', balanceAfter: '106.00' }))
      .rejects.toBeInstanceOf(ForeignKeyConstraintViolationException);
    await orm.em.fork().transactional(async (em) => {
      await em.insert(LedgerEntryEntity, row);
      await em.nativeUpdate(WalletEntity, { id: wallet.id }, { balance: '105.00', version: 2 }); // saldo anda junto
    });
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

  test('o claim do publisher acha as vencidas pelo índice, sem ler as que estão em backoff', async () => {
    const conn = orm.em.getConnection();
    // SQS fora por um tempo: muitas pendentes em backoff, poucas vencidas
    await conn.execute(`
      insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
      select gen_random_uuid(), 'w', 'X', '{}', now() - interval '1 hour', 3, now() + interval '1 hour' from generate_series(1, 5000)`);
    await conn.execute(`
      insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
      select gen_random_uuid(), 'w', 'X', '{}', now(), 1, now() - interval '1 second' from generate_series(1, 5)`);
    await conn.execute('analyze outbox_messages');
    const plan = await conn.execute<{ 'QUERY PLAN': string }[]>(`
      explain select * from outbox_messages
        where published_at is null and (next_attempt_at is null or next_attempt_at <= now())
        order by occurred_at, id limit 10 for update skip locked`);
    expect(plan.map((l) => l['QUERY PLAN']).join('\n')).toContain('outbox_due_idx');
    await conn.execute(`delete from outbox_messages where aggregate_id = 'w'`);
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
