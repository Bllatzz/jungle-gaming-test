import { MikroORM } from '@mikro-orm/postgresql';
import { type Env, loadEnv } from '../../src/config/env';
import { createOrmConfig } from '../../src/infrastructure/persistence/mikro-orm.config';

/**
 * Recria do zero um banco só dos testes ("<banco do .env>_test") e devolve o Env apontando para ele.
 * Testes que derrubam migrations ou enchem o ledger (append-only, não dá para limpar) nunca tocam o banco do dev.
 */
export async function freshTestDatabase(): Promise<Env> {
  const env = loadEnv(process.env);
  const url = new URL(env.databaseUrl);
  const name = `${url.pathname.slice(1)}_test`;
  if (!/^\w+$/.test(name)) throw new Error(`Nome de banco inesperado: ${name}`);
  const admin = await MikroORM.init(createOrmConfig(env));
  try {
    await admin.em.getConnection().execute(`drop database if exists ${name} with (force)`);
    await admin.em.getConnection().execute(`create database ${name}`);
  } finally {
    await admin.close();
  }
  url.pathname = `/${name}`;
  return { ...env, databaseUrl: url.toString() };
}
