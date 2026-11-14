import type { Logger } from '@nestjs/common';

/**
 * Repete `tick` até stop(). Sem trabalho (0) ou com erro, espera `idleMs` antes da próxima volta.
 * stop() espera a volta em andamento terminar: o que já começou é concluído antes do shutdown.
 */
export class WorkerLoop {
  private stopped = false;
  private wake?: () => void;
  private readonly done: Promise<void>;

  constructor(name: string, tick: () => Promise<number>, idleMs: number, logger: Logger) {
    this.done = (async () => {
      while (!this.stopped) {
        let worked = 0;
        try {
          worked = await tick();
        } catch (error) {
          if (!this.stopped) logger.error({ msg: `${name} failed`, error: (error as Error).message });
        }
        if (!this.stopped && worked === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, idleMs);
            this.wake = () => (clearTimeout(timer), resolve());
          });
        }
      }
    })();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    return this.done;
  }
}
