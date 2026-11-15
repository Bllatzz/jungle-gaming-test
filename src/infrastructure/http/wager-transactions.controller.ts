import { Body, Controller, UseGuards, Get, Headers, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../application/errors';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import { WagerQueries } from '../persistence/wager.queries';
import { type TransactionView, transactionJson, wagerResultJson } from './presenters';
import { annotateWager } from '../observability/tracing';
import { AuthGuard, authenticatedProvider } from './auth.guard';
import { requestContext } from './request-context';
import { parseWagerCommand, text, uuid } from './request-parsing';

/** Resultado de negócio → status. Replay devolve o mesmo status da primeira resposta. */
const STATUS_BY_RESULT: Partial<Record<WagerTransactionStatus, HttpStatus>> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  // só o replay chega aqui (o worker grava FAILED): desfecho terminal e gravado, sem efeito no saldo — como o
  // REJECTED, não adianta reenviar. 422 e não 500, para não se confundir com um bug; o corpo diz FAILED.
  [WagerTransactionStatus.Failed]: HttpStatus.UNPROCESSABLE_ENTITY,
};

@Controller()
@UseGuards(AuthGuard)
export class WagerTransactionsController {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly queries: WagerQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const command = parseWagerCommand(body, idempotencyKey);
    const request = requestContext(req);
    const result = await this.processWager.execute(command, request);
    annotateWager(command, result, request.correlationId);
    res.status(STATUS_BY_RESULT[result.status] ?? HttpStatus.INTERNAL_SERVER_ERROR);
    return wagerResultJson(result);
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string, @Req() req: Request) {
    const row = await this.queries.transaction(uuid(transactionId, 'transactionId'));
    // com auth: transação de outro provedor responde como inexistente (não vaza que o id existe)
    const provider = authenticatedProvider(req);
    return this.present(provider === undefined || row?.providerId === provider ? row : undefined);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.present(
      await this.queries.transactionByExternalId(text(providerId, 'providerId'), text(externalTransactionId, 'externalTransactionId')),
    );
  }

  private async present(row: TransactionView | undefined) {
    if (!row) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transação não encontrada');
    const wallet = await this.queries.wallet(row.walletId);
    return transactionJson(row, wallet!.currency); // FK garante que a wallet existe
  }
}
