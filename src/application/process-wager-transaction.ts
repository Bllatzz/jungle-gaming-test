import { MikroORM, UniqueConstraintViolationException } from '@mikro-orm/core';
import { Injectable, Logger } from '@nestjs/common';
import type { FailureCode } from '../domain/failure-codes';
import { InboxMessage } from '../domain/inbox-message';
import { Money } from '../domain/money';
import { applyWager } from '../domain/wager-rules';
import { WagerTransaction, type WagerTransactionStatus } from '../domain/wager-transaction';
import type { Wallet } from '../domain/wallet';
import type { WagerTransactionRow } from '../infrastructure/persistence/entities';
import { Metrics } from '../infrastructure/observability/metrics';
import { lockConflict } from '../infrastructure/persistence/transient-errors';
import { WagerRepository } from '../infrastructure/persistence/wager.repository';
import { ConflictError, NotFoundError, violatedConstraint } from './errors';
import type { RequestContext } from './event-context';
import { type WagerPayload, wagerPayloadHash } from './payload-hash';
import { recordDecision } from './wager-outcome';

export interface WagerCommand extends WagerPayload {
  idempotencyKey: string;
}

export interface WagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  /** Saldo da wallet quando a transação foi decidida — no replay, o saldo daquele momento (regra 7). */
  balance: Money;
  idempotentReplay: boolean;
}

/**
 * Entrada pela fila: a mensagem vai para o inbox na mesma transação SQL do efeito financeiro.
 * O hash gravado é o do payload de negócio: o mesmo messageId com outro payload é erro do produtor.
 */
export interface InboxEntry {
  consumerName: string;
  messageId: string;
}

/**
 * Corrida de idempotência entre wallets diferentes (locks diferentes): uma destas constraints estoura e a
 * transação é refeita — na segunda passada ela cai no replay ou no conflito. Qualquer outra violação é bug.
 */
const IDEMPOTENCY_CONSTRAINTS = new Set(['wager_tx_external_unique', 'wager_tx_idempotency_unique', 'inbox_messages_pkey']);
const MAX_ATTEMPTS = 3;

/**
 * Processa uma transação de aposta — o mesmo caminho para HTTP e SQS.
 * Tudo numa transação SQL: lock da wallet, idempotência, regras, transação, ledger, saldo e outbox.
 */
@Injectable()
export class ProcessWagerTransaction {
  private readonly logger = new Logger(ProcessWagerTransaction.name);

  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: Metrics,
  ) {}

  async execute(command: WagerCommand, request: RequestContext, inbox?: InboxEntry): Promise<WagerResult> {
    const source = inbox ? 'sqs' : 'http';
    const started = performance.now();
    try {
      const result = await this.run(command, request, inbox);
      this.observe(source, command, request, result, started);
      return result;
    } catch (error) {
      if (error instanceof ConflictError) this.metrics.inc('wager_conflicts_total', { code: error.code });
      const conflict = lockConflict(error);
      if (conflict) this.metrics.inc('wager_lock_conflicts_total', { type: conflict });
      this.logger.warn({
        msg: 'wager transaction failed', correlationId: request.correlationId, messageId: request.causationId,
        walletId: command.walletId, providerId: command.providerId, kind: command.kind,
        error: (error as { code?: string }).code ?? (error as Error).name,
      });
      throw error;
    } finally {
      this.metrics.observe('wager_processing_duration_seconds', { source }, (performance.now() - started) / 1000);
    }
  }

  /** Métrica e log do desfecho. Já commitado: uma falha aqui não pode virar erro para quem chamou. */
  private observe(source: string, command: WagerCommand, request: RequestContext, result: WagerResult, started: number): void {
    try {
      this.metrics.inc(result.idempotentReplay ? 'wager_duplicates_total' : 'wager_transactions_total',
        result.idempotentReplay ? { source } : { source, status: result.status });
      // sem valores nem saldos no log (§12): só o que identifica e o desfecho
      this.logger.log({
        msg: 'wager transaction decided', correlationId: request.correlationId, messageId: request.causationId,
        transactionId: result.transactionId, walletId: command.walletId, providerId: command.providerId, kind: command.kind,
        status: result.status, failureCode: result.failureCode, replay: result.idempotentReplay,
        durationMs: Math.round(performance.now() - started),
      });
    } catch {
      // observabilidade nunca derruba o fluxo financeiro
    }
  }

  private async run(command: WagerCommand, request: RequestContext, inbox: InboxEntry | undefined): Promise<WagerResult> {
    const payloadHash = wagerPayloadHash(command);
    newTransaction(command, payloadHash, new Date()); // valida o payload antes de pegar qualquer lock
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.orm.em.fork().transactional((em) => this.process(new WagerRepository(em), command, payloadHash, request, inbox));
      } catch (error) {
        const idempotencyRace =
          error instanceof UniqueConstraintViolationException && IDEMPOTENCY_CONSTRAINTS.has(violatedConstraint(error) ?? '');
        if (!idempotencyRace) throw error;
        this.metrics.inc('wager_lock_conflicts_total', { type: 'idempotency_race' });
        // não deveria acontecer: a cada passada a transação concorrente já está commitada
        if (attempt >= MAX_ATTEMPTS) throw new ConflictError('IDEMPOTENCY_CONFLICT', 'Transação concorrente com a mesma idempotency key');
      }
    }
  }

  private async process(
    repo: WagerRepository, command: WagerCommand, payloadHash: string, request: RequestContext, inbox: InboxEntry | undefined,
  ): Promise<WagerResult> {
    // 1. Lock da wallet: serializa tudo desta wallet, em qualquer instância.
    const wallet = await repo.lockWallet(command.walletId);
    if (!wallet) throw NotFoundError.wallet(command.walletId);

    // Inbox: mensagem já vista → segue para o replay abaixo; vista pela primeira vez → registra, junto com o efeito.
    if (inbox) {
      const seen = await repo.findInbox(inbox.consumerName, inbox.messageId);
      if (seen && seen.payloadHash !== payloadHash) {
        throw new ConflictError('MESSAGE_ID_CONFLICT', `Mensagem ${inbox.messageId} já recebida com outro conteúdo`);
      }
      if (!seen) {
        const message = InboxMessage.receive({ ...inbox, payloadHash, receivedAt: new Date() });
        message.markProcessed(message.receivedAt);
        await repo.insertInbox(message);
      }
    }

    // 2. Idempotência, já sob o lock: ninguém grava a mesma transação desta wallet ao mesmo tempo.
    const existing = await repo.findExisting(command.providerId, command.idempotencyKey, command.externalTransactionId);
    if (existing) return replay(existing, command.idempotencyKey, payloadHash, wallet);

    // 3. Regras de negócio (domínio puro). Transação nova a cada tentativa: applyWager muda o estado dela.
    const now = new Date();
    const transaction = newTransaction(command, payloadHash, now);
    const reference = command.referenceExternalTransactionId
      ? await repo.findByExternalId(command.providerId, command.referenceExternalTransactionId)
      : undefined;
    const decision = applyWager({
      wallet,
      transaction,
      reference,
      referenceAlreadyReversedBySameKind: reference ? await repo.isReversedBySameKind(reference.id, transaction.kind) : false,
      ledgerEntryId: Bun.randomUUIDv7(),
      now,
    });

    // 4. Grava tudo: transação → lançamento → saldo → eventos (ordem das FKs).
    await repo.insertTransaction(transaction, wallet.balance);
    await recordDecision(repo, transaction, wallet, decision, request, now);

    return {
      transactionId: transaction.id,
      status: transaction.status,
      failureCode: transaction.failureCode,
      balance: wallet.balance,
      idempotentReplay: false,
    };
  }
}

/** Lança InvalidTransactionError (→ 400) para payload que o domínio recusa, ex.: REFUND sem referência. */
function newTransaction(command: WagerCommand, payloadHash: string, now: Date): WagerTransaction {
  return WagerTransaction.create({
    id: Bun.randomUUIDv7(),
    providerId: command.providerId,
    externalTransactionId: command.externalTransactionId,
    idempotencyKey: command.idempotencyKey,
    payloadHash,
    walletId: command.walletId,
    playerId: command.playerId,
    roundId: command.roundId,
    gameId: command.gameId,
    kind: command.kind,
    money: command.money,
    referenceExternalTransactionId: command.referenceExternalTransactionId,
    createdAt: now,
  });
}

/**
 * Mesma key + mesmo payload → o resultado gravado. Qualquer outra coincidência → conflito, não replay.
 * Devolve o estado atual da transação: uma PENDING_REFERENCE resolvida depois responde com o desfecho.
 */
function replay(existing: WagerTransactionRow, idempotencyKey: string, payloadHash: string, wallet: Wallet): WagerResult {
  if (existing.idempotencyKey !== idempotencyKey || existing.payloadHash !== payloadHash) {
    throw new ConflictError(
      'IDEMPOTENCY_CONFLICT',
      `Transação ${existing.externalTransactionId} do provider ${existing.providerId} já existe com outro payload ou outra idempotency key`,
    );
  }
  // toda transação gravada por este use case tem saldo observado; sem ele, a regra 7 não tem como ser cumprida
  if (existing.observedBalance == null) throw new Error(`Transação ${existing.id} sem saldo observado`);
  return {
    transactionId: existing.id,
    status: existing.status,
    failureCode: existing.failureCode ?? undefined,
    balance: Money.from({ amount: existing.observedBalance, currency: wallet.currency }),
    idempotentReplay: true,
  };
}
