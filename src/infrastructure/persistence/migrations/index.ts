// Lista de migrations montada a partir dos arquivos da pasta, em ordem de nome (= ordem de criação).
// O MikroORM descobre arquivos via fs.glob, que o Bun 1.3 ainda não suporta (withFileTypes); aqui a
// descoberta é feita com readdirSync, então migration nova não precisa ser registrada à mão.
import { readdirSync } from 'node:fs';
import type { Migration } from '@mikro-orm/migrations';

type MigrationClass = new (...args: any[]) => Migration;

const files = readdirSync(import.meta.dir).filter((f) => /^Migration\d{14}\.ts$/.test(f)).sort();

export const migrations: MigrationClass[] = await Promise.all(
  files.map(async (file) => {
    const name = file.slice(0, -3);
    const mod = (await import(`./${file}`)) as Record<string, MigrationClass>;
    if (!mod[name]) throw new Error(`${file} não exporta a classe ${name}`);
    return mod[name];
  }),
);
