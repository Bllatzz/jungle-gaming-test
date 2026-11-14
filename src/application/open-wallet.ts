import { Injectable } from '@nestjs/common';
import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wager-events';
import type { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { openWallet, type Wallet } from '../domain/wallet';
import { ConflictError, UniqueViolationError } from './errors';
import { eventContext, type RequestContext } from './event-context';
import { UnitOfWork } from './ports';

/** Wallet + (se saldo inicial > 0) transação OPENING + lançamento + eventos, numa transação SQL só. */
@Injectable()
export class OpenWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(command: { playerId: string; initialBalance: Money }, request: RequestContext): Promise<Wallet> {
    const now = new Date();
    const { wallet, opening } = openWallet({
      walletId: Bun.randomUUIDv7(),
      playerId: command.playerId,
      initialBalance: command.initialBalance,
      openingTransactionId: Bun.randomUUIDv7(),
      openingLedgerEntryId: Bun.randomUUIDv7(),
      now,
    });
    try {
      await this.uow.transaction(async (repo) => {
        await repo.insertWallet(wallet);
        if (!opening) return;
        await repo.insertTransaction(opening.transaction, wallet.balance);
        await repo.appendLedgerEntry(opening.ledgerEntry, wallet.version);
        const ctx = eventContext(request, now);
        await repo.enqueue([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening.transaction, wallet, ctx())),
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, opening.ledgerEntry, ctx())),
        ]);
      });
    } catch (error) {
      if (error instanceof UniqueViolationError && error.constraint === 'wallets_player_currency_unique') {
        throw new ConflictError('WALLET_ALREADY_EXISTS', `Player ${command.playerId} já tem wallet em ${wallet.currency}`);
      }
      throw error;
    }
    return wallet;
  }
}
