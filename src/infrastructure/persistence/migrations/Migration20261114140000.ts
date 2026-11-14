import { Migration } from '@mikro-orm/migrations';

/**
 * Agenda do worker de PENDING_REFERENCE (§7.1): quantas vezes a referência já foi procurada e quando
 * procurar de novo (null = já). Só muda enquanto a transação não é terminal (o trigger garante o resto).
 */
export class Migration20261114140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions
        add column reference_attempts integer not null default 0 check (reference_attempts >= 0),
        add column next_reference_attempt_at timestamptz;`);
    this.addSql(`
      create index wager_tx_reference_due_idx on wager_transactions (next_reference_attempt_at nulls first, id)
        where status = 'PENDING_REFERENCE';`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index wager_tx_reference_due_idx;`);
    this.addSql(`alter table wager_transactions drop column next_reference_attempt_at, drop column reference_attempts;`);
  }
}
