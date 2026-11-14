import { Migration } from '@mikro-orm/migrations';

/**
 * - observed_balance: saldo da wallet no momento da decisão. Regra 7: o replay devolve o saldo
 *   daquele momento, inclusive para LOSS e REJECTED (que não têm lançamento no ledger).
 * - wallet_version: versão da wallet produzida pelo lançamento. Atribuída sob o lock da wallet, é
 *   estritamente crescente por wallet: ordem e cursor estáveis do histórico, sem depender de relógio.
 */
export class Migration20261114130000 extends Migration {
  override async up(): Promise<void> {
    // Funciona também em banco com dados: as colunas nascem nulas, são preenchidas e só depois apertadas.
    this.addSql(`alter table wager_transactions add column observed_balance numeric(20, 2) check (observed_balance >= 0);`);
    this.addSql(`alter table wallet_ledger_entries add column wallet_version integer check (wallet_version >= 1);`);

    // O ledger é append-only: o trigger é desligado só dentro desta migration (que roda numa transação).
    this.addSql(`alter table wallet_ledger_entries disable trigger ledger_no_update_delete;`);
    this.addSql(`
      update wallet_ledger_entries l set wallet_version = n.version
        from (select id, row_number() over (partition by wallet_id order by created_at, id) as version
                from wallet_ledger_entries) n
       where n.id = l.id;`);
    this.addSql(`alter table wallet_ledger_entries enable trigger ledger_no_update_delete;`);
    this.addSql(`alter table wallet_ledger_entries alter column wallet_version set not null;`);
    this.addSql(`
      alter table wallet_ledger_entries add constraint ledger_wallet_version_unique unique (wallet_id, wallet_version);`);
    // o unique acima já indexa (wallet_id, wallet_version): o índice por data perdeu o sentido
    this.addSql(`drop index ledger_wallet_created_idx;`);

    // Transações antigas: o saldo daquele momento só é conhecido quando houve lançamento. As demais
    // ficam sem valor, por isso a regra vale para linhas novas (NOT VALID) e não é revalidada no passado.
    // O trigger de transação terminal também é desligado aqui, só para este preenchimento.
    this.addSql(`alter table wager_transactions disable trigger wager_tx_terminal_is_final;`);
    this.addSql(`
      update wager_transactions t set observed_balance = l.balance_after
        from wallet_ledger_entries l where l.transaction_id = t.id;`);
    this.addSql(`alter table wager_transactions enable trigger wager_tx_terminal_is_final;`);
    this.addSql(`
      alter table wager_transactions add constraint wager_tx_observed_balance_check
        check (status not in ('PROCESSED', 'REJECTED') or observed_balance is not null) not valid;`);
  }

  override async down(): Promise<void> {
    this.addSql(`create index ledger_wallet_created_idx on wallet_ledger_entries (wallet_id, created_at, id);`);
    this.addSql(`alter table wallet_ledger_entries drop column wallet_version;`);
    this.addSql(`alter table wager_transactions drop column observed_balance;`);
  }
}
