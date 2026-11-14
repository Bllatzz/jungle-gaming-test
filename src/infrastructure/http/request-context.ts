import type { Request } from 'express';
import type { RequestContext } from '../../application/event-context';

/** correlationId vem do header X-Correlation-Id (se for razoável) ou nasce aqui. */
const resolved = new WeakMap<Request, RequestContext>();

/** Resolvido uma vez por requisição: o log de erro (ErrorFilter) usa o mesmo id do use case. */
export function requestContext(req: Request): RequestContext {
  const cached = resolved.get(req);
  if (cached) return cached;
  const header = req.header('x-correlation-id');
  const valid = header !== undefined && /^[\w.:-]{1,100}$/.test(header);
  const context = { correlationId: valid ? header : Bun.randomUUIDv7() };
  resolved.set(req, context);
  return context;
}
