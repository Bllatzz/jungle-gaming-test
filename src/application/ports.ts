import type { InboxMessage } from '../domain/inbox-message';
import type { WalletLedgerEntry } from '../domain/ledger-entry';
import type { Money } from '../domain/money';
import type { OutboxMessage } from '../domain/outbox-message';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';

/**
 * Portas da aplicação: o que os use cases pedem ao mundo de fora. A infraestrutura implementa
 * (Postgres via MikroORM, métricas Prometheus); a aplicação não importa nada de src/infrastructure.
 * Abstract class em vez de interface porque o Nest usa a classe como token de injeção.
 */

/** O que já está gravado de uma transação: o suficiente para decidir entre replay e conflito. */
export interface RecordedWager {
  transaction: WagerTransaction;
  /** Saldo da wallet quando a transação foi decidida (regra 7). */
  observedBalance: string | null;
}

/** Uma PENDING_REFERENCE com a agenda do worker (§7.1). */
export interface PendingReference {
  transaction: WagerTransaction;
  attempts: number;
  nextAttemptAt: Date | null;
  /** correlationId de quem enviou a transação (null em linhas anteriores à migration 6). */
  correlationId: string | null;
}

/** Leitura e escrita dentro de uma transação SQL só (ver UnitOfWork). */
export interface WagerStore {
  /** Trava a wallet até o commit: nenhuma outra transação, em nenhuma instância, mexe nela. */
  lockWallet(id: string): Promise<Wallet | undefined>;
  /** Leitura sem lock (o que já está commitado): para o replay, que não muda nada. */
  findWallet(id: string): Promise<Wallet | undefined>;
  /** `open`: Idempotency-Key e hash do pedido de abertura, quando o cliente mandou a key. */
  insertWallet(wallet: Wallet, open?: { idempotencyKey: string; payloadHash: string }): Promise<void>;
  /** Wallet aberta com esta Idempotency-Key, com o hash do pedido original. */
  findWalletByOpenKey(idempotencyKey: string): Promise<{ wallet: Wallet; payloadHash: string } | undefined>;
  saveWallet(wallet: Wallet): Promise<void>;
  /** Transação já gravada com a mesma idempotency key ou o mesmo id externo do provider. */
  findExisting(providerId: string, idempotencyKey: string, externalTransactionId: string): Promise<RecordedWager | undefined>;
  findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /**
   * Referência de uma reversão: a do próprio provider (regra 2). Sem ela, uma transação de outro provider com
   * esse id externo na mesma wallet — o provider apontou para a transação errada, e a regra 2 a recusa já
   * (REFERENCE_MISMATCH) em vez de deixar em PENDING_REFERENCE até o TTL.
   */
  findReference(providerId: string, walletId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  /** Regra 4: a referência já tem um REFUND ou ROLLBACK PROCESSED (de qualquer tipo)? */
  isReversed(referenceTransactionId: string): Promise<boolean>;
  insertTransaction(transaction: WagerTransaction, observedBalance: Money, correlationId: string): Promise<void>;
  appendLedgerEntry(entry: WalletLedgerEntry, walletVersion: number): Promise<void>;
  enqueue(messages: OutboxMessage[]): Promise<void>;
  findInbox(consumerName: string, messageId: string): Promise<{ payloadHash: string } | undefined>;
  insertInbox(message: InboxMessage): Promise<void>;
  /**
   * Reserva até `limit` PENDING_REFERENCE vencidas até `until`, pulando as que outra instância está reservando:
   * cada instância trabalha em linhas diferentes. `until` é a marca da reserva (ver findPendingReference).
   */
  claimDuePendingReferences(now: Date, until: Date, limit: number): Promise<{ id: string; walletId: string }[]>;
  postponePendingReference(id: string, until: Date): Promise<void>;
  /** A transação, se ainda estiver em PENDING_REFERENCE. */
  findPendingReference(id: string): Promise<PendingReference | undefined>;
  /** Grava o novo estado de uma PENDING_REFERENCE reavaliada. */
  updatePendingTransaction(
    transaction: WagerTransaction, observedBalance: Money, schedule: { attempts: number; nextAttemptAt: Date | null },
  ): Promise<void>;
}

/**
 * Abre uma transação SQL: tudo que `work` gravar pelo store é commitado junto, ou nada.
 * Violação de UNIQUE sai como UniqueViolationError (application/errors), com o nome da constraint.
 */
export abstract class UnitOfWork {
  abstract transaction<T>(work: (store: WagerStore) => Promise<T>): Promise<T>;
  /** Falha que passa sozinha (banco fora, lock timeout): vale tentar de novo sem contar como erro do dado. */
  abstract isTransient(error: unknown): boolean;
}

export type CounterName =
  | 'wager_transactions_total'
  | 'wager_duplicates_total'
  | 'wager_conflicts_total'
  | 'wager_lock_conflicts_total'
  | 'wager_retries_total'
  | 'sqs_dead_lettered_total'
  | 'reconciliation_divergences_total';
export type HistogramName = 'wager_processing_duration_seconds';

export abstract class MetricsRecorder {
  abstract inc(name: CounterName, labels?: Record<string, string>, by?: number): void;
  abstract observe(name: HistogramName, labels: Record<string, string>, seconds: number): void;
}

/**
 * Log estruturado (JSON, um objeto por linha). O Logger do Nest já tem essa forma; a aplicação só conhece a
 * interface — cada use case recebe o seu, com o próprio nome como contexto (app.module.ts).
 */
export interface AppLogger {
  log(entry: Record<string, unknown>): void;
  warn(entry: Record<string, unknown>): void;
  error(entry: Record<string, unknown>): void;
}

/** Saldo gravado e somas do ledger lidos na mesma foto do banco. */
export abstract class ReconciliationSource {
  abstract reconciliationSnapshot(walletId: string): Promise<
    { wallet: Wallet; credits: string; debits: string; entries: number } | undefined
  >;
  /** Varredura do banco inteiro: wallets cujo saldo ≠ Σ ledger ou ≠ conta da wallet nas partidas dobradas. */
  abstract divergingWallets(): Promise<{ walletId: string; balance: string; ledgerBalance: string; postingsBalance: string }[]>;
}
