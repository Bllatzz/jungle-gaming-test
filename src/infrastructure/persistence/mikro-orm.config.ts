import { defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { join } from 'node:path';
import type { Env } from '../../config/env';
import { migrations } from './migrations';

const migrationsPath = join(import.meta.dir, 'migrations');

/** Config única do ORM: usada pelo app (Nest), pelos testes e pelo script de migrations. */
export function createOrmConfig(env: Env): Options {
  return defineConfig({
    clientUrl: env.databaseUrl,
    entities: [], // entidades entram na parte 3
    preferTs: true, // sempre rodamos TypeScript direto no Bun
    discovery: { warnWhenNoEntities: false },
    // Sem isso o driver pg espera para sempre por um Postgres pendurado: cada tentativa
    // vira uma conexão órfã e o pool se esgota (comprovado no health check).
    driverOptions: { connectionTimeoutMillis: 2000 },
    extensions: [Migrator],
    migrations: { path: migrationsPath, pathTs: migrationsPath, migrationsList: migrations },
  });
}
