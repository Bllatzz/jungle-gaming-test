import { isTransient } from '../persistence/transient-errors';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { ConflictError, NotFoundError } from '../../application/errors';
import { InvalidMoneyError, InvalidTransactionError } from '../../domain/errors';
import { InvalidRequestError } from './request-parsing';

/**
 * Um status por situação, igual em todos os endpoints, para o provedor decidir sem ler a mensagem:
 * 400 payload inválido · 404 não existe · 409 conflito · 503 transitório (pode reenviar) · 500 bug.
 * (422 e 202 não são erro: saem do controller com o resultado da transação.)
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorFilter.name);

  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const send = (status: number, code: string, message: string) => res.status(status).json({ error: code, message });

    if (error instanceof HttpException) {
      // erros do próprio Nest (rota inexistente, JSON malformado)
      send(error.getStatus(), error.getStatus() === HttpStatus.BAD_REQUEST ? 'INVALID_REQUEST' : 'HTTP_ERROR', error.message);
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
      this.logger.warn({ msg: 'transient failure', error: (error as Error).message });
      res.setHeader('Retry-After', '1');
      send(HttpStatus.SERVICE_UNAVAILABLE, 'TEMPORARILY_UNAVAILABLE', 'Falha transitória, tente de novo');
    } else {
      this.logger.error({ msg: 'unexpected error', error: error instanceof Error ? error.stack : String(error) });
      send(HttpStatus.INTERNAL_SERVER_ERROR, 'INTERNAL_ERROR', 'Erro interno');
    }
  }
}
