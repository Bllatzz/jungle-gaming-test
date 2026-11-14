import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../domain/events/wager-events';
import { OutboxMessage } from '../domain/outbox-message';
import type { WagerDecision } from '../domain/wager-rules';
import type { WagerTransaction } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WagerRepository } from '../infrastructure/persistence/wager.repository';
import { eventContext, type RequestContext } from './event-context';

/**
 * Grava o efeito de uma decisão já tomada: lançamento + saldo (se moveu dinheiro) e os eventos na outbox.
 * A linha da transação já tem que estar gravada (FK do ledger). Usado pela entrada HTTP/SQS e pelo worker
 * de referências: o mesmo efeito, na mesma transação SQL de quem chama.
 */
export async function recordDecision(
  repo: WagerRepository, transaction: WagerTransaction, wallet: Wallet, decision: WagerDecision, request: RequestContext, now: Date,
): Promise<void> {
  if (decision.status === 'PROCESSED' && decision.ledgerEntry) {
    await repo.appendLedgerEntry(decision.ledgerEntry, wallet.version);
    await repo.saveWallet(wallet);
  }
  await repo.enqueue(eventsFor(transaction, wallet, decision, request, now));
}

function eventsFor(
  transaction: WagerTransaction, wallet: Wallet, decision: WagerDecision, request: RequestContext, now: Date,
): OutboxMessage[] {
  const ctx = eventContext(request, now);
  const events =
    decision.status === 'PROCESSED'
      ? [
          WagerTransactionProcessed.from(transaction, wallet, ctx()),
          ...(decision.ledgerEntry ? [WalletBalanceChanged.from(wallet, decision.ledgerEntry, ctx())] : []),
        ]
      : decision.status === 'REJECTED'
        ? [WagerTransactionRejected.from(transaction, ctx())]
        : [WagerTransactionPendingReference.from(transaction, ctx())];
  return events.map((event) => OutboxMessage.enqueue(event));
}
