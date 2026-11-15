import type { WagerResult } from '../../application/process-wager-transaction';
import type { ReconciliationResult } from '../../application/reconcile-wallet';
import type { FailureCode } from '../../domain/failure-codes';
import type { LedgerDirection } from '../../domain/ledger-entry';
import type { WagerTransactionKind, WagerTransactionStatus } from '../../domain/wager-transaction';
import type { Wallet } from '../../domain/wallet';

// Formato JSON das respostas. Dinheiro sempre como { amount: "25.00", currency }.

/** O que a resposta lê de uma transação gravada. Forma da própria API: a HTTP não conhece a linha do ORM. */
export interface TransactionView {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  amount: string;
  currency: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status: WagerTransactionStatus;
  failureCode?: FailureCode | null;
  observedBalance?: string | null;
  createdAt: Date;
  processedAt?: Date | null;
}

/** O que a resposta lê de um lançamento do ledger. */
export interface LedgerEntryView {
  id: string;
  transactionId: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  walletVersion: number;
  createdAt: Date;
}

export const walletJson = (wallet: Wallet) => ({
  id: wallet.id,
  playerId: wallet.playerId,
  balance: wallet.balance.toJSON(),
  version: wallet.version,
});

export const wagerResultJson = (result: WagerResult) => ({
  transactionId: result.transactionId,
  status: result.status,
  ...(result.failureCode ? { failureCode: result.failureCode } : {}),
  balance: result.balance.toJSON(),
  idempotentReplay: result.idempotentReplay,
});

export const transactionJson = (row: TransactionView, walletCurrency: string) => ({
  transactionId: row.id,
  providerId: row.providerId,
  externalTransactionId: row.externalTransactionId,
  walletId: row.walletId,
  playerId: row.playerId,
  roundId: row.roundId,
  gameId: row.gameId,
  kind: row.kind,
  money: { amount: row.amount, currency: row.currency },
  referenceExternalTransactionId: row.referenceExternalTransactionId,
  referenceTransactionId: row.referenceTransactionId,
  status: row.status,
  failureCode: row.failureCode,
  balance: row.observedBalance == null ? null : { amount: row.observedBalance, currency: walletCurrency },
  createdAt: row.createdAt.toISOString(),
  processedAt: row.processedAt?.toISOString() ?? null,
});

export const ledgerEntryJson = (row: LedgerEntryView) => ({
  id: row.id,
  transactionId: row.transactionId,
  direction: row.direction,
  money: { amount: row.amount, currency: row.currency },
  balanceBefore: { amount: row.balanceBefore, currency: row.currency },
  balanceAfter: { amount: row.balanceAfter, currency: row.currency },
  walletVersion: row.walletVersion,
  createdAt: row.createdAt.toISOString(),
});

export const reconciliationJson = (r: ReconciliationResult) => ({
  walletId: r.walletId,
  storedBalance: r.storedBalance.toJSON(),
  calculatedBalance: r.calculatedBalance.toJSON(),
  difference: r.difference.toJSON(),
  consistent: r.consistent,
  checkedEntries: r.checkedEntries,
});
