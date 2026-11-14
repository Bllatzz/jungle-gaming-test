import { DeadlockException } from '@mikro-orm/core';

/**
 * Falha que passa sozinha: vale responder 503 e o cliente reenviar.
 * O conversor de erros do MikroORM para Postgres só reconhece deadlock; o resto vem como
 * DriverException genérica, então olhamos o SQLSTATE do Postgres e o código de rede do Node.
 */
const TRANSIENT_SQLSTATES = new Set([
  '55P03', // lock_not_available: estourou o lock_timeout esperando a wallet
  '57014', // query_canceled (statement_timeout)
  '53300', // too_many_connections
  '57P01', '57P02', '57P03', // Postgres desligando / reiniciando
]);
const TRANSIENT_NETWORK = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE']);

/** Nome da constraint única que estourou (o driver pg copia o campo para a exceção do MikroORM). */
export const violatedConstraint = (error: unknown): string | undefined => (error as { constraint?: string }).constraint;

/** Conflito de lock (para a métrica): estourou o lock_timeout esperando a wallet, ou deadlock. */
export function lockConflict(error: unknown): 'lock_timeout' | 'deadlock' | undefined {
  if (error instanceof DeadlockException) return 'deadlock';
  return (error as { code?: unknown } | undefined)?.code === '55P03' ? 'lock_timeout' : undefined;
}

export function isTransient(error: unknown): boolean {
  if (error instanceof DeadlockException) return true;
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && (TRANSIENT_SQLSTATES.has(code) || code.startsWith('08') || TRANSIENT_NETWORK.has(code))) return true;
  // pool do pg cheio por mais que connectionTimeoutMillis, ou conexão caiu no meio
  return /timeout exceeded when trying to connect|Connection terminated/i.test(error.message);
}
