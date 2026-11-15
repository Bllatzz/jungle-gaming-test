// Migrations rodando no Bun (sem a CLI do MikroORM, que depende de Node).
// Uso: bun run migration:create | migration:up | migration:down
import { MikroORM } from '@mikro-orm/postgresql';
import { SQL } from 'bun';
import { loadEnv } from '../../config/env';
import { createOrmConfig } from './mikro-orm.config';

const command = process.argv[2];
if (!['create', 'up', 'down'].includes(command ?? '')) {
  console.error(`Comando desconhecido: ${command} (use create | up | down)`);
  process.exit(1);
}
/** Chave do advisory lock: dois `migration:up` ao mesmo tempo (deploys, réplicas) rodam um depois do outro. */
const MIGRATION_LOCK_KEY = 7_201_114;
// migrations rodam como dono das tabelas; o app conecta com o role de runtime (sem ownership)
const loaded = loadEnv(process.env);
const env = { ...loaded, databaseUrl: loaded.migrationDatabaseUrl };
let orm: MikroORM | undefined;
// conexão própria e reservada: o lock é de sessão e vive até ela fechar (inclusive se o processo morrer)
const lockClient = new SQL(env.databaseUrl);
const lock = await lockClient.reserve();

try {
  await lock`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
  orm = await MikroORM.init(createOrmConfig(env));
  if (command === 'create') {
    // Sempre em branco: o schema é escrito à mão (checks, triggers e índices parciais que o diff
    // automático do MikroORM não conhece e tentaria apagar).
    const result = await orm.migrator.create(undefined, true);
    console.log(`Criada: ${result.fileName} — escreva o SQL (a lista em migrations/index.ts é montada pelos arquivos)`);
  } else if (command === 'up') {
    console.log(`Aplicadas: ${(await orm.migrator.up()).length}`);
  } else {
    console.log(`Revertidas: ${(await orm.migrator.down()).length}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await orm?.close();
  lock.release();
  await lockClient.close();
}
