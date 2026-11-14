/** Erros da camada de aplicação: o recurso não existe ou o pedido conflita com o que já está gravado. */
export class NotFoundError extends Error {
  constructor(readonly code: 'WALLET_NOT_FOUND' | 'TRANSACTION_NOT_FOUND', message: string) {
    super(message);
  }

  static wallet(walletId: string): NotFoundError {
    return new NotFoundError('WALLET_NOT_FOUND', `Wallet ${walletId} não encontrada`);
  }
}

/** Violação de UNIQUE no banco (traduzida pelo UnitOfWork), com o nome da constraint que estourou. */
export class UniqueViolationError extends Error {
  constructor(readonly constraint: string | undefined, options?: { cause: unknown }) {
    super(`Violação de unicidade: ${constraint ?? 'desconhecida'}`, options);
  }
}

export class ConflictError extends Error {
  constructor(readonly code: 'IDEMPOTENCY_CONFLICT' | 'WALLET_ALREADY_EXISTS' | 'MESSAGE_ID_CONFLICT', message: string) {
    super(message);
  }
}
