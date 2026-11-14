import { Body, Controller, UseGuards, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NotFoundError } from '../../application/errors';
import { OpenWallet } from '../../application/open-wallet';
import { ReconcileWallet } from '../../application/reconcile-wallet';
import { WagerQueries } from '../persistence/wager.queries';
import { ledgerEntryJson, reconciliationJson, walletJson } from './presenters';
import { AuthGuard } from './auth.guard';
import { requestContext } from './request-context';
import { InvalidRequestError, parseOpenWallet, uuid } from './request-parsing';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 200;

@Controller('wallets')
@UseGuards(AuthGuard)
export class WalletsController {
  constructor(
    private readonly openWallet: OpenWallet,
    private readonly reconcileWallet: ReconcileWallet,
    private readonly queries: WagerQueries,
  ) {}

  @Post()
  async open(@Body() body: unknown, @Req() req: Request) {
    return walletJson(await this.openWallet.execute(parseOpenWallet(body), requestContext(req)));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.queries.wallet(uuid(walletId, 'walletId'));
    if (!wallet) throw NotFoundError.wallet(walletId);
    return walletJson(wallet);
  }

  /** Cursor opaco = wallet_version do último item, em base64url. Estável: a versão nunca muda nem se repete. */
  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const id = uuid(walletId, 'walletId');
    if (!(await this.queries.wallet(id))) throw NotFoundError.wallet(walletId);
    const pageSize = parseLimit(limit);
    const { rows, hasMore } = await this.queries.ledgerPage(id, decodeCursor(cursor), pageSize);
    const last = rows.at(-1);
    return {
      items: rows.map(ledgerEntryJson),
      nextCursor: hasMore && last ? Buffer.from(String(last.walletVersion)).toString('base64url') : null,
    };
  }

  @Post(':walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconcile(@Param('walletId') walletId: string) {
    return reconciliationJson(await this.reconcileWallet.execute(uuid(walletId, 'walletId')));
  }
}

function parseLimit(limit: string | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE) throw new InvalidRequestError(`limit deve ser inteiro entre 1 e ${MAX_PAGE}`);
  return n;
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const decoded = Buffer.from(cursor, 'base64url').toString();
  // até 9 dígitos: cabe no integer do Postgres (sem isso, um cursor enorme vira erro 500 no banco)
  if (!/^[1-9]\d{0,8}$/.test(decoded)) throw new InvalidRequestError('cursor inválido');
  return Number(decoded);
}
