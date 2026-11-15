import { Migration } from '@mikro-orm/migrations';

/**
 * Ordem estrita por wallet no publisher: o claim procura, para cada candidata, um evento anterior ainda não
 * publicado da mesma wallet (a "cabeça"). Este índice responde isso sem varrer a outbox pendente inteira.
 */
export class Migration20261115140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create index outbox_wallet_head_idx on outbox_messages (aggregate_id, occurred_at, id)
        where published_at is null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index outbox_wallet_head_idx;`);
  }
}
