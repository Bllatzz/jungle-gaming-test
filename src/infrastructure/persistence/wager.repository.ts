import { type EntityManager, LockMode } from '@mikro-orm/core';
import type { PendingReference, WagerStore } from '../../application/ports';
import type { InboxMessage } from '../../domain/inbox-message';
import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import type { Money } from '../../domain/money';
import type { OutboxMessage } from '../../domain/outbox-message';
import { type WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import {
  InboxMessageEntity, type InboxMessageRow, LedgerEntryEntity, OutboxMessageEntity, WagerTransactionEntity,
  type WagerTransactionRow, WalletEntity,
} from './entities';
import * as map from './mappers';

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

  async insertWallet(wallet: Wallet): Promise<void> {
    await this.em.insert(WalletEntity, map.toWalletRow(wallet));
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const { balance, version, updatedAt } = map.toWalletRow(wallet);
    await this.em.nativeUpdate(WalletEntity, { id: wallet.id }, { balance, version, updatedAt });
  }

  /** Transação já gravada com a mesma idempotency key ou o mesmo id externo do provider. */
  async findExisting(providerId: string, idempotencyKey: string, externalTransactionId: string): Promise<WagerTransactionRow | undefined> {
    const row = await this.em.findOne(WagerTransactionEntity, {
      providerId,
      $or: [{ idempotencyKey }, { externalTransactionId }],
    });
    return row ?? undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
    return row ? map.toWagerTransaction(row) : undefined;
  }

  /** Regra 4: a referência já foi revertida por uma transação PROCESSED do mesmo kind? */
  async isReversedBySameKind(referenceTransactionId: string, kind: WagerTransactionKind): Promise<boolean> {
    const count = await this.em.count(WagerTransactionEntity, {
      referenceTransactionId, kind, status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insertTransaction(transaction: WagerTransaction, observedBalance: Money): Promise<void> {
    await this.em.insert(WagerTransactionEntity, map.toWagerTransactionRow(transaction, observedBalance));
  }

  async appendLedgerEntry(entry: WalletLedgerEntry, walletVersion: number): Promise<void> {
    await this.em.insert(LedgerEntryEntity, map.toLedgerEntryRow(entry, walletVersion));
  }

  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length > 0) await this.em.insertMany(OutboxMessageEntity, messages.map(map.toOutboxMessageRow));
  }

  async findInbox(consumerName: string, messageId: string): Promise<InboxMessageRow | undefined> {
    return (await this.em.findOne(InboxMessageEntity, { consumerName, messageId })) ?? undefined;
  }

  async insertInbox(message: InboxMessage): Promise<void> {
    await this.em.insert(InboxMessageEntity, map.toInboxMessageRow(message));
  }

  /**
   * Eventos pendentes e vencidos, travados com SKIP LOCKED: publishers concorrentes pegam lotes
   * disjuntos, e o lock vale até o commit (que grava publishedAt ou o próximo retry).
   */
  async claimDueOutbox(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxMessageEntity,
      { publishedAt: null, $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }] },
      { orderBy: { occurredAt: 'asc', id: 'asc' }, limit, lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE },
    );
    return rows.map(map.toOutboxMessage);
  }

  async saveOutbox(messages: OutboxMessage[]): Promise<void> {
    for (const message of messages) {
      const { attempts, nextAttemptAt, publishedAt } = map.toOutboxMessageRow(message);
      await this.em.nativeUpdate(OutboxMessageEntity, { id: message.id }, { attempts, nextAttemptAt, publishedAt });
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
      ? { transaction: map.toWagerTransaction(row), attempts: row.referenceAttempts, nextAttemptAt: row.nextReferenceAttemptAt ?? null }
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
