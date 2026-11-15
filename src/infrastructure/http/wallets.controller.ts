import { Body, Controller, UseGuards, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { NotFoundError } from '../../application/errors';
import { OpenWallet } from '../../application/open-wallet';
import { ReconcileWallet } from '../../application/reconcile-wallet';
import { WagerQueries } from '../persistence/wager.queries';
import { ledgerEntryJson, reconciliationJson, walletJson } from './presenters';
import { AuthGuard } from './auth.guard';
import { requestContext } from './request-context';
import { InvalidRequestError, parseOpenWallet, text, uuid } from './request-parsing';

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

  /** Idempotency-Key opcional: com ela, reenviar o mesmo pedido devolve a mesma wallet (201) em vez de 409. */
  @Post()
  async open(@Body() body: unknown, @Headers('idempotency-key') idempotencyKey: string | undefined, @Req() req: Request) {
    const key = idempotencyKey === undefined ? undefined : text(idempotencyKey, 'Idempotency-Key');
    return walletJson(await this.openWallet.execute(parseOpenWallet(body), requestContext(req), key));
  }

  @Get(':walletId')
  async get(@Param('walletId') walletId: string) {
    const wallet = await this.queries.wallet(uuid(walletId, 'walletId'));
    if (!wallet) throw NotFoundError.wallet(walletId);
    return walletJson(wallet);
  }

  /**
   * Cursor opaco = id do último lançamento da página (base64url). Não expõe posição nem contagem, não dá para
   * "pular" para outro ponto sem ter visto aquela página, e só vale na própria wallet. Estável: o ledger é
   * append-only e a ordem é wallet_version, que nunca muda nem se repete.
   */
  @Get(':walletId/ledger')
  async ledger(@Param('walletId') walletId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    const id = uuid(walletId, 'walletId');
    if (!(await this.queries.wallet(id))) throw NotFoundError.wallet(walletId);
    const pageSize = parseLimit(limit);
    const page = await this.queries.ledgerPage(id, decodeCursor(cursor), pageSize);
    if (!page) throw new InvalidRequestError('cursor inválido');
    const last = page.rows.at(-1);
    return {
      items: page.rows.map(ledgerEntryJson),
      nextCursor: page.hasMore && last ? Buffer.from(last.id).toString('base64url') : null,
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

function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const decoded = Buffer.from(cursor, 'base64url').toString();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(decoded)) throw new InvalidRequestError('cursor inválido');
  return decoded;
}
