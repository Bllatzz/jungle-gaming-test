import { Body, Controller, Get, Headers, HttpStatus, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { NotFoundError } from '../../application/errors';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { WagerTransactionStatus } from '../../domain/wager-transaction';
import type { WagerTransactionRow } from '../persistence/entities';
import { WagerQueries } from '../persistence/wager.queries';
import { transactionJson, wagerResultJson } from './presenters';
import { requestContext } from './request-context';
import { parseWagerCommand, text, uuid } from './request-parsing';

/** Resultado de negócio → status. Replay devolve o mesmo status da primeira resposta. */
const STATUS_BY_RESULT: Partial<Record<WagerTransactionStatus, HttpStatus>> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
};

@Controller()
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
    const result = await this.processWager.execute(parseWagerCommand(body, idempotencyKey), requestContext(req));
    res.status(STATUS_BY_RESULT[result.status] ?? HttpStatus.INTERNAL_SERVER_ERROR);
    return wagerResultJson(result);
  }

  @Get('wagering/transactions/:transactionId')
  async get(@Param('transactionId') transactionId: string) {
    return this.present(await this.queries.transaction(uuid(transactionId, 'transactionId')));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByExternalId(@Param('providerId') providerId: string, @Param('externalTransactionId') externalTransactionId: string) {
    return this.present(
      await this.queries.transactionByExternalId(text(providerId, 'providerId'), text(externalTransactionId, 'externalTransactionId')),
    );
  }

  private async present(row: WagerTransactionRow | undefined) {
    if (!row) throw new NotFoundError('TRANSACTION_NOT_FOUND', 'Transação não encontrada');
    const wallet = await this.queries.wallet(row.walletId);
    return transactionJson(row, wallet!.currency); // FK garante que a wallet existe
  }
}
