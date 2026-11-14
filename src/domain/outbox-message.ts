import { InvalidTransactionStateError } from './errors';
import type { IntegrationEvent } from './events/integration-event';

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 300_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

/** Evento gravado na mesma transação SQL da mudança financeira; publicado depois por um worker. */
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(event.eventId, event.aggregateId, event.eventType, { ...event.toJSON() }, event.occurredAt, 0);
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id, state.aggregateId, state.eventType, state.payload, state.occurredAt,
      state.attempts, state.nextAttemptAt, state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }
  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }
  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
  }

  /** Incrementa attempts e agenda a próxima tentativa: 1s, 2s, 4s… com teto de 5 min. */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts++;
    const delay = Math.min(BASE_DELAY_MS * 2 ** (this._attempts - 1), MAX_DELAY_MS);
    this._nextAttemptAt = new Date(now.getTime() + delay);
  }

  private assertPending(): void {
    if (!this.isPending()) throw new InvalidTransactionStateError(`Outbox ${this.id} já publicada`);
  }
}
