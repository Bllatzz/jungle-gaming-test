import type { WagerResult } from '../../application/process-wager-transaction';
import type { ReconciliationResult } from '../../application/reconcile-wallet';
import type { Wallet } from '../../domain/wallet';
import type { LedgerEntryRow, WagerTransactionRow } from '../persistence/entities';

// Formato JSON das respostas. Dinheiro sempre como { amount: "25.00", currency }.

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

export const transactionJson = (row: WagerTransactionRow, walletCurrency: string) => ({
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
  balance: row.observedBalance === null ? null : { amount: row.observedBalance, currency: walletCurrency },
  createdAt: row.createdAt.toISOString(),
  processedAt: row.processedAt?.toISOString() ?? null,
});

export const ledgerEntryJson = (row: LedgerEntryRow) => ({
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
