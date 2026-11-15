import { Migration } from '@mikro-orm/migrations';

/**
 * Partidas dobradas (diferencial do §6.4). Cada lançamento da wallet vira duas partidas em `ledger_postings`:
 * a conta da wallet (passivo da casa com o jogador) no mesmo sentido do lançamento, e a contrapartida
 * `provider:<providerId>` no sentido oposto (OPENING cai em `provider:internal`).
 *
 * As partidas nascem de um trigger no INSERT do lançamento, na mesma transação SQL: nenhum caminho do app
 * (HTTP, fila, worker) consegue mover saldo sem gerar as duas pernas. Um constraint trigger deferido confere,
 * no commit, que débitos = créditos por transação, e a tabela é append-only como o ledger.
 */
export class Migration20261114160000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table ledger_postings (
        id              bigint generated always as identity primary key,
        transaction_id  uuid           not null references wager_transactions (id),
        account         text           not null,
        direction       text           not null check (direction in ('DEBIT', 'CREDIT')),
        amount          numeric(20, 2) not null check (amount > 0),
        currency        char(3)        not null check (currency ~ '^[A-Z]{3}$'),
        created_at      timestamptz    not null,
        -- uma perna por conta em cada transação
        constraint ledger_postings_transaction_account_unique unique (transaction_id, account)
      );`);
    // Saldo por conta (wallet ou provider) e balancete.
    this.addSql(`create index ledger_postings_account_idx on ledger_postings (account, currency);`);

    this.addSql(`
      create function ledger_post_double_entry() returns trigger language plpgsql as $$
      declare
        provider text;
      begin
        select provider_id into strict provider from wager_transactions where id = new.transaction_id;
        insert into ledger_postings (transaction_id, account, direction, amount, currency, created_at) values
          (new.transaction_id, 'wallet:' || new.wallet_id, new.direction, new.amount, new.currency, new.created_at),
          (new.transaction_id, 'provider:' || provider,
           case new.direction when 'CREDIT' then 'DEBIT' else 'CREDIT' end, new.amount, new.currency, new.created_at);
        return null;
      end $$;`);
    this.addSql(`
      create trigger ledger_post_double_entry after insert on wallet_ledger_entries
        for each row execute function ledger_post_double_entry();`);

    // Deferido: as duas pernas entram em comandos separados; só no commit a transação precisa fechar.
    this.addSql(`
      create function ledger_postings_balanced() returns trigger language plpgsql as $$
      begin
        if exists (
          select 1 from ledger_postings where transaction_id = new.transaction_id
          group by currency
          having sum(case direction when 'DEBIT' then amount else -amount end) <> 0
        ) then
          raise exception 'ledger_postings of transaction % do not balance (debits <> credits)', new.transaction_id;
        end if;
        return null;
      end $$;`);
    this.addSql(`
      create constraint trigger ledger_postings_balanced after insert on ledger_postings
        deferrable initially deferred for each row execute function ledger_postings_balanced();`);

    this.addSql(`
      create function ledger_postings_append_only() returns trigger language plpgsql as $$
      begin
        raise exception 'ledger_postings is append-only (% blocked)', tg_op;
      end $$;`);
    this.addSql(`
      create trigger ledger_postings_no_update_delete before update or delete on ledger_postings
        for each row execute function ledger_postings_append_only();`);
    this.addSql(`
      create trigger ledger_postings_no_truncate before truncate on ledger_postings
        for each statement execute function ledger_postings_append_only();`);

    // Banco com dados: os lançamentos que já existem ganham as duas pernas.
    this.addSql(`
      insert into ledger_postings (transaction_id, account, direction, amount, currency, created_at)
      select l.transaction_id, leg.account, leg.direction, l.amount, l.currency, l.created_at
        from wallet_ledger_entries l
        join wager_transactions t on t.id = l.transaction_id
        cross join lateral (values
          ('wallet:' || l.wallet_id, l.direction),
          ('provider:' || t.provider_id, case l.direction when 'CREDIT' then 'DEBIT' else 'CREDIT' end)
        ) as leg (account, direction)
       order by l.wallet_id, l.wallet_version;`);
  }

  override async down(): Promise<void> {
    this.addSql('drop trigger ledger_post_double_entry on wallet_ledger_entries;');
    this.addSql('drop function ledger_post_double_entry();');
    this.addSql('drop table ledger_postings;');
    this.addSql('drop function ledger_postings_balanced();');
    this.addSql('drop function ledger_postings_append_only();');
  }
}
