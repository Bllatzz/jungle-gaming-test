import { InvalidLedgerEntryError } from './errors';
import type { Money } from './money';

export enum LedgerDirection {
  Debit = 'DEBIT',
  Credit = 'CREDIT',
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}
export type CreateLedgerEntryProps = LedgerEntryState;

/** Lançamento imutável: só campos readonly, nenhum método de transição, objeto congelado. */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {
    Object.freeze(this);
  }

  /** Valida a aritmética: balanceBefore ± money === balanceAfter, sem saldo final negativo. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);
    const { money, balanceBefore, balanceAfter } = entry;
    if (money.currency !== balanceBefore.currency || money.currency !== balanceAfter.currency) {
      throw new InvalidLedgerEntryError('Lançamento com moedas misturadas');
    }
    if (!money.isPositive()) throw new InvalidLedgerEntryError('Lançamento precisa de valor positivo');
    if (balanceAfter.isNegative()) throw new InvalidLedgerEntryError('Lançamento deixaria saldo negativo');
    if (!entry.isBalanced()) throw new InvalidLedgerEntryError('Lançamento desbalanceado');
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id, state.walletId, state.transactionId, state.direction,
      state.money, state.balanceBefore, state.balanceAfter, state.createdAt,
    );
  }

  isBalanced(): boolean {
    const delta = this.direction === LedgerDirection.Credit ? this.money : this.money.negate();
    return this.balanceBefore.add(delta).equals(this.balanceAfter);
  }
}
