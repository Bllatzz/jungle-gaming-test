/** Erros da camada de aplicação: o recurso não existe ou o pedido conflita com o que já está gravado. */
export class NotFoundError extends Error {
  constructor(readonly code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND', message: string) {
    super(message);
  }

  static wallet(walletId: string): NotFoundError {
    return new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} não encontrada`);
  }
}

/** Nome da constraint única que estourou (o driver pg copia o campo para a exceção do MikroORM). */
export const violatedConstraint = (error: unknown): string | undefined => (error as { constraint?: string }).constraint;

export class ConflictError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'WALLET_ALREADY_EXISTS', message: string) {
    super(message);
  }
}
