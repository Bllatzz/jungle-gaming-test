import { MikroORM } from '@mikro-orm/postgresql';
import { type Env, loadEnv } from '../../src/config/env';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

/**
 * Recria do zero um banco só dos testes ("<banco do .env>_test_<suite>") e devolve o Env apontando para ele.
 * Testes que derrubam migrations ou enchem o ledger (append-only, não dá para limpar) nunca tocam o banco
 * do dev; cada suíte tem o seu, então suítes rodando ao mesmo tempo não se atropelam.
 */
export async function freshTestDatabase(suite: string, migrate = false): Promise<Env> {
  const env = loadEnv(process.env);
  const url = new URL(env.databaseUrl);
  const name = `${url.pathname.slice(1)}_test_${suite}`;
  if (!/^\w+$/.test(name)) throw new Error(`Nome de banco inesperado: ${name}`);
  const admin = await MikroORM.init(createOrmConfig(env));
  try {
    await admin.em.getConnection().execute(`drop database if exists ${name} with (force)`);
    await admin.em.getConnection().execute(`create database ${name}`);
  } finally {
    await admin.close();
  }
  url.pathname = `/${name}`;
  // workers desligados: um teste que quer consumer/publisher chama as voltas direto (determinístico)
  const testEnv = { ...env, databaseUrl: url.toString(), workersEnabled: false };
  if (migrate) {
    const orm = await MikroORM.init(createOrmConfig(testEnv));
    await orm.migrator.up().finally(() => orm.close());
  }
  return testEnv;
}

/**
 * Invariante final (§13) de uma vez, para o banco inteiro da suíte: wallets cujo saldo ≠ saldo reconstruído
 * pelo ledger, ou ≠ saldo da conta da wallet nas partidas dobradas.
 */
export async function walletsDivergingFromLedger(orm: MikroORM): Promise<{ id: string; balance: string }[]> {
  return orm.em.fork().getConnection().execute(`
    select w.id, w.balance::text as balance
    from wallets w
    left join (select wallet_id, sum(case direction when 'CREDIT' then amount else -amount end) as net
                 from wallet_ledger_entries group by wallet_id) l on l.wallet_id = w.id
    left join (select account, sum(case direction when 'CREDIT' then amount else -amount end) as net
                 from ledger_postings group by account) p on p.account = 'wallet:' || w.id
    where w.balance <> coalesce(l.net, 0) or w.balance <> coalesce(p.net, 0)`);
}

/**
 * Corrompe o saldo de uma wallet "por fora", como um operador que contornou o banco: desliga o trigger que
 * amarra saldo e ledger (migration 7) só nesta transação. É a única forma de produzir a divergência que a
 * reconciliação e a auditoria precisam detectar.
 */
export async function corruptBalance(orm: MikroORM, walletId: string, balance: string): Promise<void> {
  await orm.em.fork().transactional(async (em) => {
    const run = (sql: string, params: unknown[] = []) => em.getConnection().execute(sql, params, 'run', em.getTransactionContext());
    await run('alter table wallets disable trigger wallets_match_ledger');
    await run('update wallets set balance = ? where id = ?', [balance, walletId]);
    await run('alter table wallets enable trigger wallets_match_ledger');
  });
}
