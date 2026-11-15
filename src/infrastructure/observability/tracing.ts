import { context, propagation, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, type SpanExporter, TracerProvider } from '@opentelemetry/sdk-trace';
import type { WagerCommand, WagerResult } from '../../application/process-wager-transaction';

/**
 * OpenTelemetry (tracing). Instrumentação manual: a automática do OTel para Node depende de hooks de módulo
 * que o Bun não cobre. Spans: requisição HTTP → decisão do use case; mensagem SQS → decisão; publicação da
 * outbox. O contexto (traceparent W3C) viaja no header HTTP, no atributo da mensagem SQS e na linha da outbox,
 * então um evento publicado continua o trace da transação que o gerou.
 * Desligado sem OTEL_EXPORTER_OTLP_ENDPOINT: a API do OTel vira no-op e nada é exportado.
 */
let provider: TracerProvider | undefined;

/** Liga o SDK. `exporter` existe para os testes (memória); sem ele, OTLP/HTTP para o endpoint. */
export function startTracing(endpoint: string | undefined, exporter?: SpanExporter): void {
  if (provider || (!endpoint && !exporter)) return;
  provider = new TracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'wagering-processor' }),
    spanProcessors: [new BatchSpanProcessor({
      exporter: exporter ?? new OTLPTraceExporter({ url: `${endpoint!.replace(/\/$/, '')}/v1/traces` }),
    })],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
}

/** Exporta já o que estiver pendente (testes). */
export async function flushTracing(): Promise<void> {
  await provider?.forceFlush();
}

/** Exporta o que estiver pendente e desliga (shutdown do app). */
export async function stopTracing(): Promise<void> {
  await provider?.shutdown();
}

export const tracer = () => trace.getTracer('wagering-processor');

/** Atributos da decisão no span ativo (HTTP ou mensagem SQS); no-op com o tracing desligado. */
export function annotateWager(command: WagerCommand, result: WagerResult, correlationId: string): void {
  trace.getActiveSpan()?.setAttributes({
    'wager.transaction_id': result.transactionId, 'wager.wallet_id': command.walletId, 'wager.provider_id': command.providerId,
    'wager.kind': command.kind, 'wager.status': result.status, 'wager.replay': result.idempotentReplay,
    'wager.correlation_id': correlationId,
  });
}

/** Roda `work` dentro de um span filho de `parent` (traceparent recebido), marcando erro se lançar. */
export async function inSpan<T>(
  name: string, attributes: Record<string, string>, work: (span: Span) => Promise<T>, parent?: string,
): Promise<T> {
  const parentContext = parent ? propagation.extract(context.active(), { traceparent: parent }) : context.active();
  return tracer().startActiveSpan(name, { attributes }, parentContext, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** traceparent do span ativo (undefined sem tracing ou fora de span): o que vai para a outbox e o SQS. */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent;
}
