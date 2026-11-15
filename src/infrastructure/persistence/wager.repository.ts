import { type EntityManager, LockMode } from '@mikro-orm/core';
import type { PendingReference, RecordedWager, WagerStore } from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import type { Money } from '../../domain/money';
import type { OutboxMessage } from '../../domain/outbox-message';
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import {
  InboxMessageEntity, type InboxMessageRow, LedgerEntryEntity, OutboxMessageEntity, WagerTransactionEntity,
  WalletEntity,
} from './entities';
import * as map from './mappers';
import { currentTraceparent } from '../observability/tracing';

/** Lock de wallet que demora mais que isso vira erro transitório (503) em vez de pendurar a requisição. */
const LOCK_TIMEOUT = '5s';

/**
 * Leitura e escrita de uma transação SQL só. Recebe o EntityManager de dentro de em.transactional():
 * tudo que for gravado aqui é commitado junto, ou nada. Inserts em ordem explícita porque as linhas
 * não declaram relações (o Unit of Work não saberia ordenar pelas FKs).
 */
export class WagerRepository implements WagerStore {
  constructor(private readonly em: EntityManager) {}

  /** SELECT … FOR UPDATE: a partir daqui, nenhuma outra transação mexe nessa wallet até o commit. */
  async lockWallet(id: string): Promise<Wallet | undefined> {
    await this.em.getConnection().execute(`set local lock_timeout = '${LOCK_TIMEOUT}'`, [], 'run', this.em.getTransactionContext());
    const row = await this.em.findOne(WalletEntity, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return row ? map.toWallet(row) : undefined;
  }

  async findWallet(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(WalletEntity, { id });
    return row ? map.toWallet(row) : undefined;
  }

  async insertWallet(wallet: Wallet, open?: { idempotencyKey: string; payloadHash: string }): Promise<void> {
    await this.em.insert(WalletEntity, {
      ...map.toWalletRow(wallet), openIdempotencyKey: open?.idempotencyKey ?? null, openPayloadHash: open?.payloadHash ?? null,
    });
  }

  async findWalletByOpenKey(idempotencyKey: string): Promise<{ wallet: Wallet; payloadHash: string } | undefined> {
    const row = await this.em.findOne(WalletEntity, { openIdempotencyKey: idempotencyKey });
    return row ? { wallet: map.toWallet(row), payloadHash: row.openPayloadHash! } : undefined; // CHECK: key ⇔ hash
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const { balance, version, updatedAt } = map.toWalletRow(wallet);
    await this.em.nativeUpdate(WalletEntity, { id: wallet.id }, { balance, version, updatedAt });
  }

  /** Transação já gravada com a mesma idempotency key ou o mesmo id externo do provider. */
  async findExisting(providerId: string, idempotencyKey: string, externalTransactionId: string): Promise<RecordedWager | undefined> {
    const row = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      $or: [{ idempotencyKey }, { externalTransactionId }],
    });
    return row ? { transaction: map.toWagerTransaction(row), observedBalance: row.observedBalance ?? null } : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return row ? map.toWagerTransaction(row) : undefined;
  }

  async findReference(providerId: string, walletId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const own = await this.findByExternalId(providerId, externalTransactionId);
    if (own) return own;
    const other = await this.em.findOne(WagerTransactionEntity, { walletId, externalTransactionId, providerId: { $ne: providerId } });
    return other ? map.toWagerTransaction(other) : undefined;
  }

  /** Regra 4: a referência já tem um REFUND ou ROLLBACK PROCESSED (de qualquer tipo)? */
  async isReversed(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insertTransaction(transaction: WagerTransaction, observedBalance: Money, correlationId: string): Promise<void> {
    await this.em.insert(WagerTransactionEntity, { ...map.toWagerTransactionRow(transaction, observedBalance), correlationId });
  }

  async appendLedgerEntry(entry: WalletLedgerEntry, walletVersion: number): Promise<void> {
    await this.em.insert(LedgerEntryEntity, map.toLedgerEntryRow(entry, walletVersion));
  }

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    // o trace de quem gravou segue com o evento (tracing.ts); null com o tracing desligado
    const traceparent = currentTraceparent() ?? null;
    if (messages.length > 0) await this.em.insertMany(OutboxMessageEntity, messages.map((m) => ({ ...map.toOutboxMessageRow(m), traceparent })));
  }

  async findInbox(consumerName: string, messageId: string): Promise<InboxMessageRow | undefined> {
    return (await this.em.findOne(InboxMessageEntity, { consumerName, messageId })) ?? undefined;
  }

  async insertInbox(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageEntity, map.toInboxMessageRow(message));
  }

  /**
   * Reserva (lease) até `limit` eventos pendentes e vencidos: empurra next_attempt_at para `until` e devolve as
   * linhas. O lock dura só esta transação — quem chama commita antes de falar com o SQS; a reserva vale até
   * `until` (publisher que morreu solta sozinho).
   *
   * Ordem estrita por wallet: só entra uma wallet cujo evento mais antigo ainda não publicado (a "cabeça") está
   * vencido, e essa cabeça é travada com SKIP LOCKED. Enquanto um publisher tem a cabeça (reservada ou em
   * backoff), nenhum outro pega eventos posteriores da mesma wallet; publishers concorrentes ficam com wallets
   * disjuntas. A ordem é a de `seq` (sequência do banco sorteada com a wallet travada), não a de occurred_at,
   * que vem do relógio de cada instância (migration 20261115150000).
   */
  async claimDueOutbox(now: Date, until: Date, limit: number): Promise<{ message: OutboxMessage; traceparent: string | null }[]> {
    const run = <T>(sql: string, params: unknown[]) => this.em.getConnection().execute<T>(sql, params, 'all', this.em.getTransactionContext());
    const heads = await run<{ aggregate_id: string }[]>(
      `select o.aggregate_id from outbox_messages o
        where o.published_at is null and (o.next_attempt_at is null or o.next_attempt_at <= ?)
          and not exists (select 1 from outbox_messages p
                           where p.aggregate_id = o.aggregate_id and p.published_at is null
                             and p.seq < o.seq)
        order by o.seq
        limit ? for update skip locked`,
      [now, limit],
    );
    if (heads.length === 0) return [];
    const ids = await run<{ id: string; seq: string }[]>(
      `update outbox_messages set next_attempt_at = ?
        where id in (select id from outbox_messages
                      where aggregate_id in (${heads.map(() => '?').join(', ')}) and published_at is null
                        and (next_attempt_at is null or next_attempt_at <= ?)
                      order by seq
                      limit ? for update)
        returning id, seq`,
      [until, ...heads.map((h: { aggregate_id: string }) => h.aggregate_id), now, limit],
    );
    if (ids.length === 0) return [];
    const seqOf = new Map<string, bigint>(ids.map((r: { id: string; seq: string }) => [r.id, BigInt(r.seq)]));
    const rows = await this.em.find(OutboxMessageEntity, { id: { $in: [...seqOf.keys()] } });
    rows.sort((x, y) => (seqOf.get(x.id)! < seqOf.get(y.id)! ? -1 : 1));
    return rows.map((row) => ({ message: map.toOutboxMessage(row), traceparent: row.traceparent ?? null }));
  }

  /**
   * Grava publishedAt ou o próximo retry, só se a reserva ainda for deste publisher (next_attempt_at = `leasedUntil`).
   * Reserva vencida e pega por outro: não sobrescreve (o evento sai de novo — duplicata segura, mesmo eventId).
   */
  async saveOutbox(messages: OutboxMessage[], leasedUntil: Date): Promise<void> {
    for (const message of messages) {
      const { attempts, nextAttemptAt, publishedAt } = map.toOutboxMessageRow(message);
      await this.em.nativeUpdate(
        OutboxMessageEntity,
        { id: message.id, publishedAt: null, nextAttemptAt: leasedUntil },
        { attempts, nextAttemptAt, publishedAt },
      );
    }
  }

  /**
   * Reserva as PENDING_REFERENCE vencidas (null = ainda não tentada) empurrando a próxima tentativa para `until`.
   * SKIP LOCKED: duas instâncias reservando ao mesmo tempo pegam linhas diferentes, e a reservada só volta a
   * vencer em `until` (instância que morreu no meio solta a linha sozinha). NO KEY UPDATE não briga com a FK
   * de quem referencia a linha.
   */
  async claimDuePendingReferences(now: Date, until: Date, limit: number): Promise<{ id: string; walletId: string }[]> {
    return this.em.getConnection().execute<{ id: string; walletId: string }[]>(
      `update wager_transactions set next_reference_attempt_at = ?
        where id in (select id from wager_transactions
                      where status = 'PENDING_REFERENCE'
                        and (next_reference_attempt_at is null or next_reference_attempt_at <= ?)
                      order by next_reference_attempt_at nulls first, id
                      limit ? for no key update skip locked)
        returning id, wallet_id as "walletId"`,
      [until, now, limit], 'all', this.em.getTransactionContext(),
    );
  }

  async postponePendingReference(id: string, until: Date): Promise<void> {
    await this.em.nativeUpdate(
      WagerTransactionEntity, { id, status: WagerTransactionStatus.PendingReference }, { nextReferenceAttemptAt: until },
    );
  }

  async findPendingReference(id: string): Promise<PendingReference | undefined> {
    const row = await this.em.findOne(WagerTransactionEntity, { id, status: WagerTransactionStatus.PendingReference });
    return row
      ? {
          transaction: map.toWagerTransaction(row), attempts: row.referenceAttempts,
          nextAttemptAt: row.nextReferenceAttemptAt ?? null, correlationId: row.correlationId ?? null,
        }
      : undefined;
  }

  /** Grava o novo estado de uma PENDING_REFERENCE reavaliada (o trigger recusa se ela já for terminal). */
  async updatePendingTransaction(
    transaction: WagerTransaction, observedBalance: Money, schedule: { attempts: number; nextAttemptAt: Date | null },
  ): Promise<void> {
    const row = map.toWagerTransactionRow(transaction, observedBalance);
    const updated = await this.em.nativeUpdate(
      WagerTransactionEntity,
      { id: transaction.id, status: WagerTransactionStatus.PendingReference },
      {
        status: row.status,
        referenceTransactionId: row.referenceTransactionId,
        failureCode: row.failureCode,
        processedAt: row.processedAt,
        // ainda pendente: o replay continua devolvendo o saldo da primeira resposta (202), não o de agora
        ...(row.status === WagerTransactionStatus.PendingReference ? {} : { observedBalance: row.observedBalance }),
        referenceAttempts: schedule.attempts,
        nextReferenceAttemptAt: schedule.nextAttemptAt,
      },
    );
    if (updated !== 1) throw new Error(`Transação ${transaction.id} não estava mais em PENDING_REFERENCE`);
  }
}
