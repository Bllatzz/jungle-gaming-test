import { Migration } from '@mikro-orm/migrations';

/**
 * saldo == ledger garantido pelo schema (antes só a reconciliação sob demanda via).
 *
 * Duas regras, conferidas no commit (constraint triggers deferidos: lançamento e saldo são gravados em
 * comandos separados da mesma transação):
 * 1. Encadeamento: cada lançamento continua o anterior da wallet — wallet_version = anterior + 1 e
 *    balance_before = balance_after do anterior (o primeiro parte de 0).
 * 2. A wallet bate com o último lançamento: balance = balance_after e version = wallet_version
 *    (sem lançamento nenhum, saldo 0).
 * Com as duas, balance = Σ créditos − Σ débitos por construção (a soma telescopa a partir de 0).
 * Custo: duas buscas por índice (wallet_id, wallet_version) no commit de cada transação que move saldo.
 */
export class Migration20261115110000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function ledger_entry_continues_chain() returns trigger language plpgsql as $$
      declare
        prev record;
      begin
        select wallet_version, balance_after into prev from wallet_ledger_entries
         where wallet_id = new.wallet_id and wallet_version < new.wallet_version
         order by wallet_version desc limit 1;
        if not found then
          if new.balance_before <> 0 then
            raise exception 'ledger entry % is the first of wallet % but balance_before is %', new.id, new.wallet_id, new.balance_before;
          end if;
        elsif prev.wallet_version + 1 <> new.wallet_version or prev.balance_after <> new.balance_before then
          raise exception 'ledger entry % does not continue the chain of wallet % (previous version %, balance_after %)',
            new.id, new.wallet_id, prev.wallet_version, prev.balance_after;
        end if;
        return null;
      end $$;`);
    this.addSql(`
      create constraint trigger ledger_entry_continues_chain after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function ledger_entry_continues_chain();`);

    this.addSql(`
      create function wallet_matches_ledger() returns trigger language plpgsql as $$
      declare
        target uuid;
        w record;
        last record;
      begin
        -- if, não case: o PL/pgSQL resolve new.wallet_id mesmo no ramo que não roda, e wallets não tem a coluna
        if tg_table_name = 'wallets' then target := new.id; else target := new.wallet_id; end if;
        select balance, version into w from wallets where id = target;
        select wallet_version, balance_after into last from wallet_ledger_entries
         where wallet_id = target order by wallet_version desc limit 1;
        if not found then
          if w.balance <> 0 then
            raise exception 'wallet % has balance % but no ledger entries', target, w.balance;
          end if;
        elsif w.balance <> last.balance_after or w.version <> last.wallet_version then
          raise exception 'wallet % (balance %, version %) does not match its last ledger entry (balance_after %, version %)',
            target, w.balance, w.version, last.balance_after, last.wallet_version;
        end if;
        return null;
      end $$;`);
    this.addSql(`
      create constraint trigger wallets_match_ledger after insert or update of balance, version on wallets
        deferrable initially deferred for each row execute function wallet_matches_ledger();`);
    this.addSql(`
      create constraint trigger ledger_matches_wallet after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function wallet_matches_ledger();`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop trigger ledger_matches_wallet on wallet_ledger_entries;`);
    this.addSql(`drop trigger wallets_match_ledger on wallets;`);
    this.addSql(`drop function wallet_matches_ledger();`);
    this.addSql(`drop trigger ledger_entry_continues_chain on wallet_ledger_entries;`);
    this.addSql(`drop function ledger_entry_continues_chain();`);
  }
}
