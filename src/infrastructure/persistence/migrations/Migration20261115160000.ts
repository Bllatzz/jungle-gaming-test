import { Migration } from '@mikro-orm/migrations';

/**
 * Referência de outro provider na mesma wallet (findReference): só é procurada quando a do próprio provider não
 * existe, mas o worker de PENDING_REFERENCE repete essa busca a cada tentativa. Sem o índice, ela leria todas
 * as transações da wallet.
 */
export class Migration20261115160000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create index wager_tx_wallet_external_idx on wager_transactions (wallet_id, external_transaction_id);`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop index wager_tx_wallet_external_idx;`);
  }
}
