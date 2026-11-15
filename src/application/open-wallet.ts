import { WagerTransactionProcessed, WalletBalanceChanged } from '../domain/events/wager-events';
import type { Money } from '../domain/money';
import { OutboxMessage } from '../domain/outbox-message';
import { openWallet, Wallet } from '../domain/wallet';
import { ConflictError, UniqueViolationError } from './errors';
import { eventContext, type RequestContext } from './event-context';
import { openWalletPayloadHash } from './payload-hash';
import { UnitOfWork } from './ports';

type OpenWalletCommand = { playerId: string; initialBalance: Money };

/**
 * Wallet + (se saldo inicial > 0) transação OPENING + lançamento + eventos, numa transação SQL só.
 * Com `idempotencyKey` (header Idempotency-Key), reenviar o mesmo pedido devolve a mesma resposta em vez de
 * 409: a key e o hash do pedido ficam na wallet (UNIQUE), mesma regra das transações (outro payload → 409).
 */
export class OpenWallet {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(command: OpenWalletCommand, request: RequestContext, idempotencyKey?: string): Promise<Wallet> {
    const open = idempotencyKey ? { idempotencyKey, payloadHash: openWalletPayloadHash(command) } : undefined;
    if (open) {
      const replayed = await this.replay(command, open);
      if (replayed) return replayed;
    }
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
        await repo.insertWallet(wallet, open);
        if (!opening) return;
        await repo.insertTransaction(opening.transaction, wallet.balance, request.correlationId);
        await repo.appendLedgerEntry(opening.ledgerEntry, wallet.version);
        const ctx = eventContext(request, now);
        await repo.enqueue([
          OutboxMessage.enqueue(WagerTransactionProcessed.from(opening.transaction, wallet, ctx())),
          OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, opening.ledgerEntry, ctx())),
        ]);
      });
    } catch (error) {
      if (!(error instanceof UniqueViolationError)) throw error;
      // corrida com um reenvio do mesmo pedido: o outro commitou primeiro, vira replay
      const replayed = open ? await this.replay(command, open) : undefined;
      if (replayed) return replayed;
      if (error.constraint === 'wallets_player_currency_unique') {
        throw new ConflictError('WALLET_ALREADY_EXISTS', `Player ${command.playerId} já tem wallet em ${wallet.currency}`);
      }
      throw error;
    }
    return wallet;
  }

  /** A resposta da abertura original: a wallet como nasceu (saldo inicial, version 1), não o saldo de agora. */
  private async replay(command: OpenWalletCommand, open: { idempotencyKey: string; payloadHash: string }): Promise<Wallet | undefined> {
    const found = await this.uow.transaction((repo) => repo.findWalletByOpenKey(open.idempotencyKey));
    if (!found) return undefined;
    if (found.payloadHash !== open.payloadHash) {
      throw new ConflictError('IDEMPOTENCY_CONFLICT', `Idempotency-Key ${open.idempotencyKey} já usada em outro pedido de abertura`);
    }
    return Wallet.open({ id: found.wallet.id, playerId: command.playerId, initialBalance: command.initialBalance, now: found.wallet.createdAt });
  }
}
