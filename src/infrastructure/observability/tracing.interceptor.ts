import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { inSpan } from './tracing';

/** Um span por requisição HTTP, filho do `traceparent` do cliente (se vier). O use case roda dentro dele. */
export class TracingInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const res = ctx.switchToHttp().getResponse<Response>();
    const route = (req.route as { path?: string } | undefined)?.path ?? req.path; // rota com :params, não o id
    return from(
      inSpan(`HTTP ${req.method} ${route}`, { 'http.request.method': req.method, 'http.route': route }, async (span) => {
        const result = await lastValueFrom(next.handle(), { defaultValue: undefined });
        span.setAttribute('http.response.status_code', res.statusCode);
        return result;
      }, req.header('traceparent')),
    );
  }
}
