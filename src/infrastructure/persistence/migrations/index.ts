// Lista explícita de migrations, em ordem. O MikroORM descobre arquivos via fs.glob,
// que o Bun 1.3 ainda não suporta (withFileTypes). Ao criar uma migration, adicione-a aqui.
import type { Migration } from '@mikro-orm/migrations';

export const migrations: (new (...args: any[]) => Migration)[] = [];
