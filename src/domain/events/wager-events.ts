import { InvalidTransactionStateError } from '../errors';
import type { FailureCode } from '../failure-codes';
import type { LedgerDirection, WalletLedgerEntry } from '../ledger-entry';
import type { MoneyProps } from '../money';
import { type WagerTransaction, type WagerTransactionKind, WagerTransactionStatus } from '../wager-transaction';
import type { Wallet } from '../wallet';
import { type EventContext, IntegrationEvent } from './integration-event';

// aggregateId = walletId em todos: vira o MessageGroupId do SQS FIFO e garante ordem por wallet.

interface TransactionData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  status: WagerTransactionStatus;
}

/** Evento no estado errado é bug de quem chama: falha alto em vez de publicar contrato quebrado. */
function assertStatus(t: WagerTransaction, expected: WagerTransactionStatus): void {
  if (t.status !== expected) {
    throw new InvalidTransactionStateError(`Evento de ${expected} para transação ${t.id} em ${t.status}`);
  }
}

function transactionData(t: WagerTransaction): TransactionData {
  return {
    transactionId: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    status: t.status,
  };
}

export interface WagerTransactionProcessedData extends TransactionData {
  referenceTransactionId?: string;
  balance: MoneyProps;
}

/** Qualquer transação aplicada, inclusive LOSS. */
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, wallet: Wallet, ctx: EventContext): WagerTransactionProcessed {
    assertStatus(transaction, WagerTransactionStatus.Processed);
    if (wallet.id !== transaction.walletId) {
      throw new InvalidTransactionStateError(`Saldo da wallet ${wallet.id} em evento da wallet ${transaction.walletId}`);
    }
    return new WagerTransactionProcessed({
      ...ctx,
      aggregateId: transaction.walletId,
      data: {
        ...transactionData(transaction),
        ...(transaction.referenceTransactionId && { referenceTransactionId: transaction.referenceTransactionId }),
        balance: wallet.balance.toJSON(),
      },
    });
  }
}

export interface WagerTransactionRejectedData extends TransactionData {
  failureCode: FailureCode;
}

/** Transação rejeitada por regra de negócio. */
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    assertStatus(transaction, WagerTransactionStatus.Rejected);
    return new WagerTransactionRejected({
      ...ctx,
      aggregateId: transaction.walletId,
      data: { ...transactionData(transaction), failureCode: transaction.failureCode as FailureCode },
    });
  }
}

export interface WagerTransactionPendingReferenceData extends TransactionData {
  referenceExternalTransactionId: string;
}

/** Referência ausente: a transação aguarda reprocessamento. */
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    assertStatus(transaction, WagerTransactionStatus.PendingReference);
    return new WagerTransactionPendingReference({
      ...ctx,
      aggregateId: transaction.walletId,
      data: { ...transactionData(transaction), referenceExternalTransactionId: transaction.referenceExternalTransactionId as string },
    });
  }
}

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    return new WalletBalanceChanged({
      ...ctx,
      aggregateId: wallet.id,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
