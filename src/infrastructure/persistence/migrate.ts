// Migrations rodando no Bun (sem a CLI do MikroORM, que depende de Node).
// Uso: bun run migration:create | migration:up | migration:down
import { MikroORM } from '@mikro-orm/postgresql';
import { loadEnv } from '../../config/env';
import { createOrmConfig } from './mikro-orm.config';

const command = process.argv[2];
if (!['create', 'up', 'down'].includes(command ?? '')) {
  console.error(`Comando desconhecido: ${command} (use create | up | down)`);
  process.exit(1);
}
let orm: MikroORM | undefined;

try {
  orm = await MikroORM.init(createOrmConfig(loadEnv(process.env)));
  if (command === 'create') {
    // Sempre em branco: o schema é escrito à mão (checks, triggers e índices parciais que o diff
    // automático do MikroORM não conhece e tentaria apagar).
    const result = await orm.migrator.create(undefined, true);
    console.log(`Criada: ${result.fileName} — escreva o SQL e registre-a em migrations/index.ts`);
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
}
