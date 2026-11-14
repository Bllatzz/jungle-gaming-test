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

/** Invariante final (§13) de uma vez, para o banco inteiro da suíte: wallets cujo saldo ≠ saldo reconstruído pelo ledger. */
export async function walletsDivergingFromLedger(orm: MikroORM): Promise<{ id: string; balance: string }[]> {
  return orm.em.fork().getConnection().execute(`
    select w.id, w.balance::text as balance
    from wallets w
    left join wallet_ledger_entries l on l.wallet_id = w.id
    group by w.id
    having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)`);
}
