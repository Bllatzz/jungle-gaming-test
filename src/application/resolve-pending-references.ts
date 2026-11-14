import { Injectable, Logger } from '@nestjs/common';
import { FailureCode } from '../domain/failure-codes';
import { applyWager, type WagerDecision } from '../domain/wager-rules';
import type { WagerTransaction } from '../domain/wager-transaction';
import { MetricsRecorder, UnitOfWork, type WagerStore } from './ports';
import { recordDecision } from './wager-outcome';

/**
 * Limite do §7.1: 10 tentativas com espera 1s, 2s, 4s … até 60s (~4 min no total). Reversão antes da
 * aposta é corrida entre mensagens em voo — chega em segundos. Depois disso a referência não vem mais.
 */
export const MAX_REFERENCE_ATTEMPTS = 10;
const MAX_DELAY_MS = 60_000;
const BATCH = 20;
/** Linha que deu erro (não regra de negócio) volta só depois disso: não trava as outras nem gira em loop. */
const ERROR_DELAY_MS = 60_000;
/** Reserva de um lote: maior que o pior caso de 20 linhas esperando o lock da wallet (5 s cada). */
const CLAIM_MS = 120_000;

type Outcome = { transaction: WagerTransaction; attempts: number; stillPending: boolean };

export function nextReferenceAttemptAt(attempts: number, now: Date): Date {
  return new Date(now.getTime() + Math.min(1_000 * 2 ** (attempts - 1), MAX_DELAY_MS));
}

/**
 * Worker agendado das PENDING_REFERENCE: reavalia cada transação vencida com as mesmas regras (applyWager),
 * sob o lock da wallet. Várias instâncias podem rodar: cada volta reserva um lote com SKIP LOCKED, então
 * as instâncias não varrem as mesmas linhas, e a linha relida sob o lock só é tratada se a reserva ainda for dela.
 */
@Injectable()
export class ResolvePendingReferences {
  private readonly logger = new Logger(ResolvePendingReferences.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly metrics: MetricsRecorder,
  ) {}

  /** Uma volta. Devolve quantas transações reavaliou (0 = nada a fazer: o loop descansa). */
  async runOnce(): Promise<number> {
    const now = new Date();
    const claimedUntil = new Date(now.getTime() + CLAIM_MS);
    const due = await this.uow.transaction((store) => store.claimDuePendingReferences(now, claimedUntil, BATCH));
    let evaluated = 0;
    for (const { id, walletId } of due) {
      let outcome: Outcome | undefined;
      try {
        outcome = await this.uow.transaction((store) => this.resolve(store, id, walletId, claimedUntil));
      } catch (error) {
        // erro de infraestrutura ou bug: adia a linha (sem gastar tentativa) para não travar as outras
        this.logger.error({ msg: 'pending reference retry failed', transactionId: id, walletId, error: (error as Error).message });
        await this.uow
          .transaction((store) => store.postponePendingReference(id, new Date(Date.now() + ERROR_DELAY_MS)))
          .catch(() => undefined); // banco fora: a próxima volta tenta de novo
        continue;
      }
      if (!outcome) continue;
      evaluated++;
      // só depois do commit: métrica e log nunca contam trabalho desfeito
      const { transaction, attempts, stillPending } = outcome;
      const log = { transactionId: transaction.id, walletId, providerId: transaction.providerId, attempts };
      if (stillPending) {
        this.metrics.inc('wager_retries_total', { component: 'pending_reference' });
        this.logger.log({ msg: 'pending reference still missing', ...log });
      } else {
        this.metrics.inc('wager_transactions_total', { source: 'pending_worker', status: transaction.status });
        this.logger.log({ msg: 'pending reference resolved', ...log, status: transaction.status, failureCode: transaction.failureCode });
      }
    }
    return evaluated;
  }

  /** undefined: a linha já foi resolvida, ou a reserva venceu e outra instância a pegou. */
  private async resolve(repo: WagerStore, id: string, walletId: string, claimedUntil: Date): Promise<Outcome | undefined> {
    const wallet = await repo.lockWallet(walletId);
    const pending = await repo.findPendingReference(id); // relida sob o lock
    const now = new Date();
    if (!wallet || !pending || pending.nextAttemptAt?.getTime() !== claimedUntil.getTime()) return undefined;

    const { transaction } = pending;
    const reference = await repo.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId!);
    let decision: WagerDecision = applyWager({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversedBySameKind: reference ? await repo.isReversedBySameKind(reference.id, transaction.kind) : false,
      ledgerEntryId: Bun.randomUUIDv7(),
      now,
    });

    const attempts = pending.attempts + 1;
    if (decision.status === 'PENDING_REFERENCE' && attempts >= MAX_REFERENCE_ATTEMPTS) {
      // referência que existe mas nunca foi aplicada é outro diagnóstico que referência que nunca chegou
      const failureCode = reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound;
      transaction.reject(failureCode);
      decision = { status: 'REJECTED', failureCode };
    }

    const stillPending = decision.status === 'PENDING_REFERENCE';
    await repo.updatePendingTransaction(transaction, wallet.balance, {
      attempts,
      nextAttemptAt: stillPending ? nextReferenceAttemptAt(attempts, now) : null,
    });
    // ainda pendente: o evento PendingReference já saiu na primeira vez
    if (!stillPending) await recordDecision(repo, transaction, wallet, decision, { correlationId: transaction.id }, now);
    return { transaction, attempts, stillPending };
  }
}
