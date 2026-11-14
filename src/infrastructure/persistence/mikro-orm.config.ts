import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { join } from 'node:path';
import type { Env } from '../../config/env';
import { entities } from './entities';
import { migrations } from './migrations';

const migrationsPath = join(import.meta.dir, 'migrations');

/** Config única do ORM: usada pelo app (Nest), pelos testes e pelo script de migrations. */
export function createOrmConfig(env: Env): Options {
  return defineConfig({
    clientUrl: env.databaseUrl,
    entities,
    preferTs: true, // sempre rodamos TypeScript direto no Bun
    // Sem isso o driver pg espera para sempre por um Postgres pendurado: cada tentativa
    // vira uma conexão órfã e o pool se esgota (comprovado no health check).
    driverOptions: { connectionTimeoutMillis: 2000 },
    extensions: [Migrator],
    // snapshot desligado: o schema é escrito à mão, o snapshot do diff automático só confundiria.
    migrations: { path: migrationsPath, pathTs: migrationsPath, migrationsList: migrations, snapshot: false },
  });
}
