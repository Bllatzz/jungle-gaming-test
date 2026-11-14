// Lista explícita de migrations, em ordem. O MikroORM descobre arquivos via fs.glob,
// que o Bun 1.3 ainda não suporta (withFileTypes). Ao criar uma migration, adicione-a aqui.
import type { Migration } from '@mikro-orm/migrations';
import { Migration20261114120000 } from './Migration20261114120000';
import { Migration20261114130000 } from './Migration20261114130000';
import { Migration20261114140000 } from './Migration20261114140000';

export const migrations: (new (...args: any[]) => Migration)[] = [
  Migration20261114120000, Migration20261114130000, Migration20261114140000,
];
