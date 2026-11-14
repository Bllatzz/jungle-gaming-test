import { Migration } from '@mikro-orm/migrations';

/**
 * Busca do publisher pelo que já venceu: com o SQS fora, as pendentes ficam em backoff (next_attempt_at no
 * futuro) e o outbox_pending_idx (occurred_at) faria o claim ler todas elas para achar as poucas vencidas.
 * O outbox_pending_idx continua: serve à métrica de lag (min(occurred_at) das não publicadas).
 */
export class Migration20261114150000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create index outbox_due_idx on outbox_messages (next_attempt_at nulls first, occurred_at, id)
        where published_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index outbox_due_idx;`);
  }
}
