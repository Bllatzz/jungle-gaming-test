import { InboxMessage } from '../../domain/inbox-message';
import { WalletLedgerEntry } from '../../domain/ledger-entry';
import { Money } from '../../domain/money';
import { OutboxMessage } from '../../domain/outbox-message';
import { WagerTransaction } from '../../domain/wager-transaction';
import { Wallet } from '../../domain/wallet';
import type { InboxMessageRow, LedgerEntryRow, OutboxMessageRow, WagerTransactionRow, WalletRow } from './entities';

// Linha ↔ domínio. Banco usa null, domínio usa undefined; Money vira (amount string, currency).
// Leitura sempre por rehydrate: o que está gravado já passou pelas regras, não revalida.

const money = (amount: string, currency: string) => Money.from({ amount, currency });

export function toWalletRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({ ...row, balance: money(row.balance, row.currency) });
}

export function toWagerTransactionRow(transaction: WagerTransaction): WagerTransactionRow {
  const { money: value, referenceExternalTransactionId, referenceTransactionId, failureCode, processedAt, ...rest } =
    transaction.toState();
  return {
    ...rest,
    amount: value.toString(),
    currency: value.currency,
    referenceExternalTransactionId: referenceExternalTransactionId ?? null,
    referenceTransactionId: referenceTransactionId ?? null,
    failureCode: failureCode ?? null,
    processedAt: processedAt ?? null,
  };
}

export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  const { amount, currency, referenceExternalTransactionId, referenceTransactionId, failureCode, processedAt, ...rest } = row;
  return WagerTransaction.rehydrate({
    ...rest,
    money: money(amount, currency),
    referenceExternalTransactionId: referenceExternalTransactionId ?? undefined,
    referenceTransactionId: referenceTransactionId ?? undefined,
    failureCode: failureCode ?? undefined,
    processedAt: processedAt ?? undefined,
  });
}

export function toLedgerEntryRow(entry: WalletLedgerEntry): LedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt,
  };
}

export function toLedgerEntry(row: LedgerEntryRow): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    ...row,
    money: money(row.amount, row.currency),
    balanceBefore: money(row.balanceBefore, row.currency),
    balanceAfter: money(row.balanceAfter, row.currency),
  });
}

export function toInboxMessageRow(message: InboxMessage): InboxMessageRow {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  };
}

export function toInboxMessage(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({ ...row, processedAt: row.processedAt ?? undefined });
}

export function toOutboxMessageRow(message: OutboxMessage): OutboxMessageRow {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    payload: message.payload as Record<string, unknown>,
    occurredAt: message.occurredAt,
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  };
}

export function toOutboxMessage(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    ...row,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
  });
}
