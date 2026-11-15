import { Migration } from '@mikro-orm/migrations';

/**
 * Regras 2 e 4 no banco, mais o que o worker de referências e o consumer precisam guardar.
 *
 * - Regra 4: uma referência tem no máximo UMA reversão PROCESSED, de qualquer tipo. O índice anterior era
 *   por (referência, tipo) e deixava REFUND + ROLLBACK da mesma BET devolverem a aposta duas vezes (§3).
 *   Num banco que já tenha os dois, o índice novo não cria e a migration falha: é dado para auditar à mão.
 * - Regra 2: FK composta da referência para (id, provider, player, wallet, moeda, rodada) da transação
 *   referenciada. Antes só o domínio garantia o mesmo contexto.
 * - correlation_id: o worker de PENDING_REFERENCE publica os eventos com o correlationId de quem enviou.
 * - consumer_message_failures: tentativas do consumer contadas pelo app (o ApproximateReceiveCount do SQS
 *   também sobe quando a mensagem é só devolvida sem processar).
 * - wallets.open_idempotency_key/open_payload_hash: POST /wallets idempotente com o header Idempotency-Key.
 */
export class Migration20261115100000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`drop index wager_tx_one_reversal_per_kind;`);
    this.addSql(`
      create unique index wager_tx_one_reversal on wager_transactions (reference_transaction_id)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');`);

    this.addSql(`
      alter table wager_transactions
        add constraint wager_tx_reference_context_unique unique (id, provider_id, player_id, wallet_id, currency, round_id),
        add constraint wager_tx_reference_context_fk
          foreign key (reference_transaction_id, provider_id, player_id, wallet_id, currency, round_id)
          references wager_transactions (id, provider_id, player_id, wallet_id, currency, round_id);`);

    this.addSql(`alter table wager_transactions add column correlation_id text;`);

    this.addSql(`
      create table consumer_message_failures (
        consumer_name  text        not null,
        message_id     text        not null,
        failures       integer     not null check (failures >= 1),
        last_failed_at timestamptz not null,
        primary key (consumer_name, message_id)
      );`);

    this.addSql(`
      alter table wallets
        add column open_idempotency_key text,
        add column open_payload_hash    text,
        add constraint wallets_open_idempotency_unique unique (open_idempotency_key),
        add constraint wallets_open_idempotency_hash_check check ((open_idempotency_key is null) = (open_payload_hash is null));`);
  }

  override async down(): Promise<void> {
    this.addSql(`
      alter table wallets drop constraint wallets_open_idempotency_hash_check, drop constraint wallets_open_idempotency_unique,
        drop column open_payload_hash, drop column open_idempotency_key;`);
    this.addSql(`drop table consumer_message_failures;`);
    this.addSql(`alter table wager_transactions drop column correlation_id;`);
    this.addSql(`
      alter table wager_transactions drop constraint wager_tx_reference_context_fk,
        drop constraint wager_tx_reference_context_unique;`);
    this.addSql(`drop index wager_tx_one_reversal;`);
    this.addSql(`
      create unique index wager_tx_one_reversal_per_kind on wager_transactions (reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK');`);
  }
}
