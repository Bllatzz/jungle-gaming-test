import { Money } from '../domain/money';
import { NotFoundError } from './errors';
import type { AppLogger, MetricsRecorder, ReconciliationSource } from './ports';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/** Confere saldo gravado × saldo reconstruído pelo ledger. Divergência é sinalizada, nunca corrigida. */
export class ReconcileWallet {
  constructor(
    private readonly queries: ReconciliationSource,
    private readonly metrics: MetricsRecorder,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string): Promise<ReconciliationResult> {
    const snapshot = await this.queries.reconciliationSnapshot(walletId);
    if (!snapshot) throw NotFoundError.wallet(walletId);
    const { wallet, credits, debits, entries } = snapshot;
    const money = (amount: string) => Money.from({ amount, currency: wallet.currency });
    // créditos e débitos somados à parte: cada soma é ≥ 0 e entra no Money.from sem sinal
    const calculatedBalance = money(credits).subtract(money(debits));
    const difference = wallet.balance.subtract(calculatedBalance);
    const consistent = difference.isZero();
    if (!consistent) {
      this.metrics.inc('reconciliation_divergences_total');
      this.logger.error({ msg: 'wallet balance diverges from ledger', walletId, difference: difference.toString() });
    }
    return { walletId, storedBalance: wallet.balance, calculatedBalance, difference, consistent, checkedEntries: entries };
  }

  /**
   * Varredura periódica do banco inteiro (worker). Os triggers já impedem a divergência; isto pega o caso de
   * alguém contornar o banco (trigger desligado, restore parcial). Sinaliza (métrica + log), nunca corrige.
   */
  async sweep(): Promise<number> {
    const diverging = await this.queries.divergingWallets();
    for (const d of diverging) {
      this.metrics.inc('reconciliation_divergences_total');
      this.logger.error({ msg: 'wallet balance diverges from ledger (sweep)', ...d });
    }
    return diverging.length;
  }
}
