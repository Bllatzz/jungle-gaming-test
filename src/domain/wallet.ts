import { CurrencyMismatchError, InsufficientFundsError, InvalidMoneyError } from './errors';
import { LedgerDirection, WalletLedgerEntry } from './ledger-entry';
import { Money } from './money';
import { WagerTransaction } from './wager-transaction';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Aggregate root. Saldo nunca negativo; toda mudança de saldo devolve o lançamento correspondente;
 * version começa em 1 e só incrementa quando o saldo muda.
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /** Só a wallet. Para abrir com saldo e o lançamento OPENING correspondente, use openWallet(). */
  static open(props: { id: string; playerId: string; initialBalance: Money; now: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new InvalidMoneyError('Saldo inicial não pode ser negativo');
    return new Wallet(props.id, props.playerId, props.initialBalance.currency, props.initialBalance, 1, props.now, props.now);
  }

  /** Reconstrução a partir da persistência — não revalida. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(state.id, state.playerId, state.currency, state.balance, state.version, state.createdAt, state.updatedAt);
  }

  get balance(): Money {
    return this._balance;
  }
  get version(): number {
    return this._version;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** O saldo cobre o débito? (Mesma moeda; a de outra moeda é rejeitada antes, por CURRENCY_MISMATCH.) */
  canDebit(money: Money): boolean {
    return !this._balance.isLessThan(money);
  }

  /** Lança InsufficientFundsError se o saldo não cobre: quem decide a rejeição de negócio é o applyWager. */
  debit(money: Money, transactionId: string, entryId: string, now: Date): WalletLedgerEntry {
    this.assertMovement(money);
    if (!this.canDebit(money)) {
      throw new InsufficientFundsError(`Saldo ${this._balance} insuficiente para debitar ${money}`);
    }
    return this.apply(LedgerDirection.Debit, money, transactionId, now, entryId);
  }

  credit(money: Money, transactionId: string, entryId: string, now: Date): WalletLedgerEntry {
    this.assertMovement(money);
    return this.apply(LedgerDirection.Credit, money, transactionId, now, entryId);
  }

  private apply(direction: LedgerDirection, money: Money, transactionId: string, now: Date, entryId: string): WalletLedgerEntry {
    const balanceBefore = this._balance;
    const balanceAfter = direction === LedgerDirection.Credit ? balanceBefore.add(money) : balanceBefore.subtract(money);
    if (!balanceAfter.fitsStorage()) throw new InvalidMoneyError(`Saldo ${balanceAfter} excede o limite de armazenamento`);
    // create valida a aritmética antes de qualquer mutação: se falhar, a wallet fica intacta.
    const entry = WalletLedgerEntry.create({
      id: entryId, walletId: this.id, transactionId, direction, money, balanceBefore, balanceAfter, createdAt: now,
    });
    this._balance = balanceAfter;
    this._version++;
    this._updatedAt = now;
    return entry;
  }

  private assertMovement(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) throw new InvalidMoneyError('Movimentação precisa de valor positivo');
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(`Wallet em ${this.currency}, operação em ${money.currency}`);
    }
  }
}

/**
 * Abertura de wallet. Saldo inicial > 0 gera, na mesma operação, a transação interna OPENING
 * (já PROCESSED) e o lançamento CREDIT de 0 → saldo inicial. A wallet sai com version 1.
 */
export function openWallet(props: {
  walletId: string;
  playerId: string;
  initialBalance: Money;
  openingTransactionId: string;
  openingLedgerEntryId: string;
  now: Date;
}): { wallet: Wallet; opening?: { transaction: WagerTransaction; ledgerEntry: WalletLedgerEntry } } {
  const wallet = Wallet.open({ id: props.walletId, playerId: props.playerId, initialBalance: props.initialBalance, now: props.now });
  if (props.initialBalance.isZero()) return { wallet };

  const transaction = WagerTransaction.opening({
    id: props.openingTransactionId, walletId: props.walletId, playerId: props.playerId, money: props.initialBalance, now: props.now,
  });
  const ledgerEntry = WalletLedgerEntry.create({
    id: props.openingLedgerEntryId,
    walletId: props.walletId,
    transactionId: transaction.id,
    direction: LedgerDirection.Credit,
    money: props.initialBalance,
    balanceBefore: Money.zero(props.initialBalance.currency),
    balanceAfter: props.initialBalance,
    createdAt: props.now,
  });
  return { wallet, opening: { transaction, ledgerEntry } };
}
