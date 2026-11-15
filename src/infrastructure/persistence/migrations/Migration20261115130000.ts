import { Migration } from '@mikro-orm/migrations';

/**
 * Role de runtime separado do dono das tabelas. O app conecta com um login membro de `wagering_runtime`
 * (criado pela infra, ver docker/postgres/init-roles.sql), que não é dono de nada: não consegue
 * `ALTER TABLE … DISABLE TRIGGER`, nem UPDATE/DELETE/TRUNCATE no ledger e nas partidas dobradas.
 * Assim a imutabilidade e saldo == ledger não dependem só de triggers que o próprio app poderia desligar.
 * O role é do cluster, não do banco: o down só revoga, não apaga (outros bancos podem usá-lo).
 */
export class Migration20261115130000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      do $$ begin
        if not exists (select from pg_roles where rolname = 'wagering_runtime') then
          create role wagering_runtime nologin;
        end if;
      end $$;`);
    this.addSql(`grant usage on schema public to wagering_runtime;`);
    this.addSql(`grant select, insert, update on wallets, wager_transactions, inbox_messages, outbox_messages to wagering_runtime;`);
    this.addSql(`grant select, insert, update, delete on consumer_message_failures to wagering_runtime;`);
    // append-only: só leitura e inserção (as partidas são inseridas pelo trigger, que roda com o role de quem chamou)
    this.addSql(`grant select, insert on wallet_ledger_entries, ledger_postings to wagering_runtime;`);
  }

  override async down(): Promise<void> {
    this.addSql(`
      revoke all on wallets, wager_transactions, inbox_messages, outbox_messages, consumer_message_failures,
                    wallet_ledger_entries, ledger_postings from wagering_runtime;`);
    this.addSql(`revoke usage on schema public from wagering_runtime;`);
  }
}
