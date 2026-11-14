import { type BeforeApplicationShutdown, Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ResolvePendingReferences } from '../../application/resolve-pending-references';
import { ENV, type Env } from '../../config/env';
import { OutboxPublisher } from '../messaging/outbox-publisher';
import { WagerConsumer } from '../messaging/wager-consumer';
import { WorkerLoop } from './worker-loop';

/**
 * Liga os três workers em toda instância (eles se coordenam pelo banco, não por eleição de líder).
 * No shutdown roda antes de o ORM e o SQS fecharem: as voltas em andamento terminam com conexão.
 */
@Injectable()
export class Workers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(Workers.name);
  private loops: WorkerLoop[] = [];

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly consumer: WagerConsumer,
    private readonly publisher: OutboxPublisher,
    private readonly pendingReferences: ResolvePendingReferences,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.workersEnabled) return;
    this.loops = [
      new WorkerLoop('wager consumer', () => this.consumer.pollOnce(), 1_000, this.logger),
      new WorkerLoop('outbox publisher', () => this.publisher.publishPending(), 500, this.logger),
      new WorkerLoop('pending references', () => this.pendingReferences.runOnce(), 1_000, this.logger),
    ];
  }

  async beforeApplicationShutdown(): Promise<void> {
    const stopped = Promise.all(this.loops.map((loop) => loop.stop()));
    this.consumer.interrupt(); // corta o long poll; a mensagem em processamento termina
    await stopped;
    if (this.loops.length > 0) this.logger.log({ msg: 'workers stopped' });
  }
}
