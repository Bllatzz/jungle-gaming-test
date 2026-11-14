import type { EventContext } from '../domain/events/integration-event';

/** Origem do pedido: correlationId (sempre) e causationId (ex.: messageId da fila, quando houver). */
export interface RequestContext {
  correlationId: string;
  causationId?: string;
}

/** Um EventContext novo por evento (cada evento tem o seu eventId). */
export function eventContext(request: RequestContext, occurredAt: Date): () => EventContext {
  return () => ({ eventId: Bun.randomUUIDv7(), ...request, occurredAt });
}
