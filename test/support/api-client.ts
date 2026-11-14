import { randomUUID } from 'node:crypto';

/** Cliente HTTP mínimo dos testes: abre wallets e envia transações para uma ou várias instâncias do app. */
export async function call(baseUrl: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

export type TestWallet = { id: string; playerId: string };

export async function openWallet(baseUrl: string, amount = '100.00'): Promise<TestWallet> {
  const res = await call(baseUrl, 'POST', '/wallets', { playerId: randomUUID(), initialBalance: { amount, currency: 'BRL' } });
  if (res.status !== 201) throw new Error(`openWallet → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** Payload válido de transação; `extra` sobrescreve o que o teste precisar. */
export function wagerPayload(wallet: TestWallet, kind: string, amount: string, extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    providerId: 'provider-a', externalTransactionId: randomUUID(), playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'round-1', gameId: 'fortune-chimp', kind, money: { amount, currency: 'BRL' }, ...extra,
  };
}

/** Idempotency key padrão recomendada pelo desafio: "{providerId}:{externalTransactionId}". */
export function send(baseUrl: string, payload: Record<string, any>, key = `${payload.providerId}:${payload.externalTransactionId}`) {
  return call(baseUrl, 'POST', '/wagering/transactions', payload, { 'idempotency-key': key });
}

/** Invariante final de todos os testes: saldo da wallet == saldo reconstruído pelo ledger. */
export async function reconcile(baseUrl: string, walletId: string) {
  return (await call(baseUrl, 'POST', `/wallets/${walletId}/reconciliation`)).body as {
    consistent: boolean; storedBalance: { amount: string }; checkedEntries: number;
  };
}
