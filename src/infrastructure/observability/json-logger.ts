import type { LoggerService } from '@nestjs/common';

type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'verbose';

/**
 * Logs estruturados: uma linha JSON por evento no stdout ({ time, level, context, msg, ...campos }).
 * Chamadas com objeto viram campos; com string viram `msg` (os logs internos do Nest).
 * Assinatura do Nest: log(message, ...params, context?) e error(message, stack?, context?).
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(line)) {}

  log(message: unknown, ...params: unknown[]) { this.emit('info', message, params); }
  error(message: unknown, ...params: unknown[]) { this.emit('error', message, params); }
  warn(message: unknown, ...params: unknown[]) { this.emit('warn', message, params); }
  debug(message: unknown, ...params: unknown[]) { this.emit('debug', message, params); }
  verbose(message: unknown, ...params: unknown[]) { this.emit('verbose', message, params); }
  fatal(message: unknown, ...params: unknown[]) { this.emit('fatal', message, params); }

  private emit(level: Level, message: unknown, params: unknown[]): void {
    const rest = [...params];
    // error(msg, stack) sem contexto: o último parâmetro é o stack, não o contexto
    const isStack = (v: unknown) => typeof v === 'string' && /\n\s+at /.test(v);
    const context = typeof rest.at(-1) === 'string' && !isStack(rest.at(-1)) ? (rest.pop() as string) : undefined;
    const stack = (level === 'error' || level === 'fatal') && typeof rest[0] === 'string' ? (rest.shift() as string) : undefined;
    const fields =
      message instanceof Error
        ? { msg: message.message, stack: message.stack }
        : typeof message === 'object' && message !== null
          ? (message as Record<string, unknown>)
          : { msg: String(message) };
    // campos reservados por último: um campo `level` no objeto não troca o nível de verdade
    const envelope = { time: new Date().toISOString(), level, context };
    const line = { ...fields, ...(stack ? { stack } : {}), ...envelope };
    let text: string;
    try {
      text = JSON.stringify(line, (_, v) =>
        typeof v === 'bigint' ? v.toString() : v instanceof Error ? { message: v.message, stack: v.stack } : v);
    } catch {
      text = JSON.stringify({ ...envelope, msg: 'unserializable log entry' }); // logar nunca derruba quem chamou
    }
    this.write(`${text}\n`);
  }
}
