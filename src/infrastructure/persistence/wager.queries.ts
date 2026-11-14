import { IsolationLevel, MikroORM } from '@mikro-orm/core';
import { Injectable } from '@nestjs/common';
import type { Wallet } from '../../domain/wallet';
import { LedgerEntryEntity, type LedgerEntryRow, WagerTransactionEntity, type WagerTransactionRow, WalletEntity } from './entities';
import * as map from './mappers';

/** Leituras para a API. Não passam pelo lock: só olham o que já foi commitado. */
@Injectable()
export class WagerQueries {
  constructor(private readonly orm: MikroORM) {}

  async wallet(id: string): Promise<Wallet | undefined> {
    const row = await this.orm.em.fork().findOne(WalletEntity, { id });
    return row ? map.toWallet(row) : undefined;
  }

  /** Página do histórico em ordem de wallet_version (estritamente crescente por wallet). */
  async ledgerPage(walletId: string, afterVersion: number, limit: number): Promise<{ rows: LedgerEntryRow[]; hasMore: boolean }> {
    const rows = await this.orm.em.fork().find(
      LedgerEntryEntity,
      { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit: limit + 1 },
    );
    return { rows: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  async transaction(id: string): Promise<WagerTransactionRow | undefined> {
    return (await this.orm.em.fork().findOne(WagerTransactionEntity, { id })) ?? undefined;
  }

  async transactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransactionRow | undefined> {
    return (await this.orm.em.fork().findOne(WagerTransactionEntity, { providerId, externalTransactionId })) ?? undefined;
  }

  /**
   * Saldo gravado e somas do ledger na mesma foto do banco (REPEATABLE READ): um lançamento
   * commitado no meio da leitura não aparece num lado só.
   */
  async reconciliationSnapshot(walletId: string): Promise<
    { wallet: Wallet; credits: string; debits: string; entries: number } | undefined
  > {
    return this.orm.em.fork().transactional(
      async (em) => {
        const row = await em.findOne(WalletEntity, { id: walletId });
        if (!row) return undefined;
        const [sums] = await em.getConnection().execute<{ credits: string; debits: string; entries: string }[]>(
          `select coalesce(sum(amount) filter (where direction = 'CREDIT'), 0)::text as credits,
                  coalesce(sum(amount) filter (where direction = 'DEBIT'), 0)::text as debits,
                  count(*)::text as entries
             from wallet_ledger_entries where wallet_id = ?`,
          [walletId], 'all', em.getTransactionContext(),
        );
        return { wallet: map.toWallet(row), credits: sums!.credits, debits: sums!.debits, entries: Number(sums!.entries) };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ, readOnly: true },
    );
  }
}
