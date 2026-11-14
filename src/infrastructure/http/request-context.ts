import type { Request } from 'express';
import type { RequestContext } from '../../application/event-context';

/** correlationId vem do header X-Correlation-Id (se for razoável) ou nasce aqui. */
export function requestContext(req: Request): RequestContext {
  const header = req.header('x-correlation-id');
  const valid = header !== undefined && /^[\w.:-]{1,100}$/.test(header);
  return { correlationId: valid ? header : Bun.randomUUIDv7() };
}
