import { expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { migrations } from '../../src/infrastructure/persistence/migrations';

// O Bun não suporta a descoberta automática de arquivos do MikroORM; a lista é manual.
// Este teste impede que uma migration criada e não registrada seja silenciosamente ignorada.
test('toda migration da pasta está registrada em migrations/index.ts', () => {
  const dir = join(import.meta.dir, '../../src/infrastructure/persistence/migrations');
  const files = readdirSync(dir)
    .filter((f) => /^Migration\w+\.ts$/.test(f))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
  expect(migrations.map((m) => m.name).sort()).toEqual(files);
});
