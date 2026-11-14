import { type EntityManager, LockMode } from '@mikro-orm/core';
import type { WalletLedgerEntry } from '../../domain/ledger-entry';
import type { Money } from '../../domain/money';
import type { OutboxMessage } from '../../domain/outbox-message';
import { type WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';
import { LedgerEntryEntity, OutboxMessageEntity, WagerTransactionEntity, type WagerTransactionRow, WalletEntity } from './entities';
import * as map from './mappers';

/** Lock de wallet que demora mais que isso vira erro transitório (503) em vez de pendurar a requisição. */
const LOCK_TIMEOUT = '5s';

/**
 * Leitura e escrita de uma transação SQL só. Recebe o EntityManager de dentro de em.transactional():
 * tudo que for gravado aqui é commitado junto, ou nada. Inserts em ordem explícita porque as linhas
 * não declaram relações (o Unit of Work não saberia ordenar pelas FKs).
 */
export class WagerRepository {
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
}
