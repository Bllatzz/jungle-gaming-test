import { describe, expect, test } from 'bun:test';
import { JsonLogger } from '../../../src/infrastructure/observability/json-logger';
import { Metrics } from '../../../src/infrastructure/observability/metrics';

describe('JsonLogger', () => {
  const capture = () => {
    const lines: Record<string, unknown>[] = [];
    return { lines, logger: new JsonLogger((line) => lines.push(JSON.parse(line))) };
  };

  test('objeto vira campos, com nível, horário e contexto', () => {
    const { lines, logger } = capture();
    logger.log({ msg: 'decided', walletId: 'w-1' }, 'ProcessWagerTransaction');
    expect(lines[0]).toMatchObject({ level: 'info', context: 'ProcessWagerTransaction', msg: 'decided', walletId: 'w-1' });
    expect(new Date(lines[0]!.time as string).toString()).not.toBe('Invalid Date');
  });

  test('string (logs internos do Nest) vira msg; error com stack separa o stack', () => {
    const { lines, logger } = capture();
    logger.log('Nest application successfully started', 'NestApplication');
    logger.error('boom', 'Error: boom\n    at x', 'ExceptionHandler');
    expect(lines[0]).toMatchObject({ level: 'info', msg: 'Nest application successfully started', context: 'NestApplication' });
    expect(lines[1]).toMatchObject({ level: 'error', msg: 'boom', stack: 'Error: boom\n    at x', context: 'ExceptionHandler' });
  });

  test('campos do objeto não trocam nível, horário nem contexto', () => {
    const { lines, logger } = capture();
    logger.error({ msg: 'x', level: 'info', context: 'falso', time: 'ontem' }, 'Real');
    expect(lines[0]).toMatchObject({ level: 'error', context: 'Real', msg: 'x' });
    expect(lines[0]!.time).not.toBe('ontem');
  });

  test('error(msg, stack) sem contexto: o stack não vira contexto', () => {
    const { lines, logger } = capture();
    logger.error('boom', 'Error: boom\n    at x');
    expect(lines[0]).toMatchObject({ msg: 'boom', stack: 'Error: boom\n    at x' });
    expect(lines[0]!.context).toBeUndefined();
  });

  test('bigint, Error e referência circular: logar nunca lança', () => {
    const { lines, logger } = capture();
    const circular: Record<string, unknown> = { msg: 'loop' };
    circular.self = circular;
    logger.log({ msg: 'big', n: 10n, err: new Error('falhou') });
    expect(() => logger.log(circular)).not.toThrow();
    expect(lines[0]).toMatchObject({ n: '10', err: { message: 'falhou' } });
    expect(lines[1]).toMatchObject({ msg: 'unserializable log entry', level: 'info' });
  });

  test('uma linha por evento, mesmo com quebra de linha no conteúdo', () => {
    const raw: string[] = [];
    new JsonLogger((line) => raw.push(line)).warn({ msg: 'a\nb' });
    expect(raw[0]!.endsWith('\n')).toBe(true);
    expect(raw[0]!.trimEnd().includes('\n')).toBe(false);
  });
});

describe('Metrics', () => {
  test('counter por combinação de labels, em ordem fixa e com escape', () => {
    const m = new Metrics();
    m.inc('wager_transactions_total', { status: 'PROCESSED', source: 'http' });
    m.inc('wager_transactions_total', { source: 'http', status: 'PROCESSED' });
    m.inc('sqs_dead_lettered_total', { error_code: 'a"b' });
    const text = m.render();
    expect(text).toContain('# TYPE wager_transactions_total counter');
    expect(text).toContain('wager_transactions_total{source="http",status="PROCESSED"} 2');
    expect(text).toContain('sqs_dead_lettered_total{error_code="a\\"b"} 1');
    expect(text).toContain('# TYPE reconciliation_divergences_total counter'); // declarada mesmo sem valor
  });

  test('histogram com buckets cumulativos, +Inf, soma e contagem', () => {
    const m = new Metrics();
    m.observe('wager_processing_duration_seconds', { source: 'sqs' }, 0.003);
    m.observe('wager_processing_duration_seconds', { source: 'sqs' }, 0.3);
    m.observe('wager_processing_duration_seconds', { source: 'sqs' }, 30);
    const text = m.render();
    expect(text).toContain('wager_processing_duration_seconds_bucket{source="sqs",le="0.005"} 1');
    expect(text).toContain('wager_processing_duration_seconds_bucket{source="sqs",le="0.5"} 2');
    expect(text).toContain('wager_processing_duration_seconds_bucket{source="sqs",le="10"} 2');
    expect(text).toContain('wager_processing_duration_seconds_bucket{source="sqs",le="+Inf"} 3');
    expect(text).toContain('wager_processing_duration_seconds_count{source="sqs"} 3');
    const sum = Number(text.match(/wager_processing_duration_seconds_sum\{source="sqs"\} (\S+)/)![1]);
    expect(sum).toBeCloseTo(30.303, 9);
  });

  test('gauges do scrape entram no fim', () => {
    expect(new Metrics().render([{ name: 'outbox_lag_seconds', help: 'lag', value: 1.5 }])).toContain(
      '# TYPE outbox_lag_seconds gauge\noutbox_lag_seconds 1.5',
    );
  });
});
