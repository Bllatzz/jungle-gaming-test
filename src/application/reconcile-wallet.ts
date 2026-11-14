import { Injectable, Logger } from '@nestjs/common';
import { Money } from '../domain/money';
import { Metrics } from '../infrastructure/observability/metrics';
import { WagerQueries } from '../infrastructure/persistence/wager.queries';
import { NotFoundError } from './errors';

export interface ReconciliationResult {
  walletId: string;
  storedBalance: Money;
  calculatedBalance: Money;
  difference: Money;
  consistent: boolean;
  checkedEntries: number;
}

/** Confere saldo gravado × saldo reconstruído pelo ledger. Divergência é sinalizada, nunca corrigida. */
@Injectable()
export class ReconcileWallet {
  private readonly logger = new Logger(ReconcileWallet.name);

  constructor(
    private readonly queries: WagerQueries,
    private readonly metrics: Metrics,
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
}
