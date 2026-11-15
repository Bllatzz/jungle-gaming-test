import { isTransient } from '../persistence/transient-errors';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ConflictError, NotFoundError } from '../../application/errors';
import { InvalidMoneyError, InvalidTransactionError } from '../../domain/errors';
import { requestContext } from './request-context';
import { InvalidRequestError } from './request-parsing';

const HTTP_CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: 'INVALID_REQUEST',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHENTICATED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN_PROVIDER',
  [HttpStatus.SERVICE_UNAVAILABLE]: 'TEMPORARILY_UNAVAILABLE',
};

/**
 * Um status por situação, igual em todos os endpoints, para o provedor decidir sem ler a mensagem:
 * 400 payload inválido · 401 sem token válido · 403 provedor agindo por outro · 404 não existe · 409 conflito · 503 transitório (pode reenviar) · 500 bug.
 * (422 e 202 não são erro: saem do controller com o resultado da transação.)
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request>();
    const where = { method: req.method, path: req.path, correlationId: requestContext(req).correlationId };
    const send = (status: number, code: string, message: string) => res.status(status).json({ error: code, message });

    if (error instanceof HttpException) {
      // erros do próprio Nest (rota inexistente, JSON malformado) e do AuthGuard (401, 403, 503 com o IdP fora)
      const status = error.getStatus();
      if (status === HttpStatus.SERVICE_UNAVAILABLE) res.setHeader('Retry-After', '1');
      send(status, HTTP_CODES[status] ?? 'HTTP_ERROR', error.message);
    } else if (error instanceof InvalidRequestError) {
      send(HttpStatus.BAD_REQUEST, 'INVALID_REQUEST', error.message);
    } else if (error instanceof InvalidMoneyError || error instanceof InvalidTransactionError) {
      // só estes vêm de entrada do cliente; os outros erros de domínio são bug (500)
      send(HttpStatus.BAD_REQUEST, error.code, error.message);
    } else if (error instanceof NotFoundError) {
      send(HttpStatus.NOT_FOUND, error.code, error.message);
    } else if (error instanceof ConflictError) {
      send(HttpStatus.CONFLICT, error.code, error.message);
    } else if (isTransient(error)) {
      this.logger.warn({ msg: 'transient failure', ...where, error: (error as Error).message });
      res.setHeader('Retry-After', '1');
      send(HttpStatus.SERVICE_UNAVAILABLE, 'TEMPORARILY_UNAVAILABLE', 'Falha transitória, tente de novo');
    } else {
      this.logger.error({ msg: 'unexpected error', ...where, error: error instanceof Error ? error.message : String(error), stack: (error as Error)?.stack });
      send(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Erro interno');
    }
  }
}
