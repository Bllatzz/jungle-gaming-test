import { InvalidTransactionError, InvalidTransactionStateError } from './errors';
import { FailureCode } from './failure-codes';
import { LedgerDirection, type WalletLedgerEntry } from './ledger-entry';
import { type WagerTransaction, WagerTransactionKind as Kind, WagerTransactionStatus as Status } from './wager-transaction';
import type { Wallet } from './wallet';

export type WagerDecision =
  | { status: 'PROCESSED'; ledgerEntry: WalletLedgerEntry | undefined } // LOSS: sem lançamento
  | { status: 'REJECTED'; failureCode: FailureCode }
  | { status: 'PENDING_REFERENCE' };

export interface ApplyWagerInput {
  wallet: Wallet;
  transaction: WagerTransaction;
  /** Resolvida pelo use case via (providerId, referenceExternalTransactionId). */
  reference: WagerTransaction | undefined;
  /** Já existe reversão PROCESSED desta referência com o mesmo kind? (regra 4, leitura literal) */
  referenceAlreadyReversedBySameKind: boolean;
  /** Id do lançamento, se houver movimento (gerado fora: o domínio é determinístico). */
  ledgerEntryId: string;
  now: Date;
}

/** Que kinds cada operação pode referenciar (§7, regra 3; WIN e LOSS podem referenciar a BET da rodada). */
const ALLOWED_REFERENCE_KINDS: Partial<Record<Kind, Kind[]>> = {
  [Kind.Win]: [Kind.Bet],
  [Kind.Loss]: [Kind.Bet],
  [Kind.Refund]: [Kind.Bet],
  [Kind.Rollback]: [Kind.Bet, Kind.Win, Kind.Refund],
};

/**
 * Decide e aplica uma transação na wallet (§7). A primeira regra violada decide o resultado.
 * Já executa a transição na transação e o débito/crédito na wallet; o use case só persiste.
 * Uma rejeição nunca altera a wallet.
 */
export function applyWager(input: ApplyWagerInput): WagerDecision {
  const { wallet, transaction, now } = input;
  // Guardas de programação, antes de qualquer mutação.
  if (transaction.isTerminal()) {
    throw new InvalidTransactionStateError(`Transação ${transaction.id} já está ${transaction.status}`);
  }
  if (transaction.walletId !== wallet.id) {
    throw new InvalidTransactionError(`Transação da wallet ${transaction.walletId} aplicada na wallet ${wallet.id}`);
  }
  // Uma referência só vale se a transação declarou uma.
  const reference = transaction.referenceExternalTransactionId ? input.reference : undefined;

  const reject = (failureCode: FailureCode): WagerDecision => {
    transaction.reject(failureCode);
    return { status: 'REJECTED', failureCode };
  };

  if (transaction.money.currency !== wallet.currency) return reject(FailureCode.CurrencyMismatch);
  if (transaction.playerId !== wallet.playerId) return reject(FailureCode.WalletPlayerMismatch);

  if (transaction.referenceExternalTransactionId) {
    // Erros que nenhuma espera resolve: rejeita já, em vez de deixar em PENDING_REFERENCE até o TTL.
    const selfReference = transaction.referenceExternalTransactionId === transaction.externalTransactionId;
    if (!ALLOWED_REFERENCE_KINDS[transaction.kind] || selfReference) return reject(FailureCode.ReferenceInvalidKind);
    if (reference && !sameContext(transaction, reference)) return reject(FailureCode.ReferenceMismatch);
    // o tipo da referência não muda enquanto ela espera: tipo errado rejeita mesmo com ela pendente
    if (reference && !ALLOWED_REFERENCE_KINDS[transaction.kind]!.includes(reference.kind)) return reject(FailureCode.ReferenceInvalidKind);

    // Regra 8: referência ausente (ou ainda não aplicada) → espera e reprocessa depois.
    if (!reference || reference.status === Status.Pending || reference.status === Status.PendingReference) {
      transaction.markPendingReference();
      return { status: 'PENDING_REFERENCE' };
    }
    const failure = validateReference(input, reference);
    if (failure) return reject(failure);
  }

  if (!transaction.affectsBalance()) {
    transaction.markProcessed(reference?.id, now);
    return { status: 'PROCESSED', ledgerEntry: undefined };
  }

  const direction = transaction.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(transaction.money)) {
    // Situações operacionalmente diferentes: aposta sem saldo vs. reversão que negativaria (regra 9).
    return reject(transaction.kind === Kind.Rollback ? FailureCode.ReversalInsufficientFunds : FailureCode.InsufficientFunds);
  }

  const ledgerEntry =
    direction === LedgerDirection.Debit
      ? wallet.debit(transaction.money, transaction.id, input.ledgerEntryId, now)
      : wallet.credit(transaction.money, transaction.id, input.ledgerEntryId, now);
  transaction.markProcessed(reference?.id, now);
  return { status: 'PROCESSED', ledgerEntry };
}

/** Regra 2: mesmo provider, player, wallet, moeda e rodada. */
function sameContext(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    reference.providerId === transaction.providerId &&
    reference.playerId === transaction.playerId &&
    reference.walletId === transaction.walletId &&
    reference.money.currency === transaction.money.currency &&
    reference.roundId === transaction.roundId
  );
}

function validateReference(input: ApplyWagerInput, reference: WagerTransaction): FailureCode | undefined {
  const { transaction } = input;
  if (reference.status !== Status.Processed) return FailureCode.ReferenceNotProcessed;
  if (!ALLOWED_REFERENCE_KINDS[transaction.kind]?.includes(reference.kind)) return FailureCode.ReferenceInvalidKind;

  if (transaction.requiresReference()) {
    // "Já revertida" antes de "valor errado": diz ao provedor para não reenviar.
    if (input.referenceAlreadyReversedBySameKind) return FailureCode.ReferenceAlreadyReversed; // regra 4
    if (!transaction.money.equals(reference.money)) return FailureCode.AmountMismatch; // regra 5
  }
  return undefined;
}
