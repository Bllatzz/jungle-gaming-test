import { expect, test } from 'bun:test';
import { Glob } from 'bun';
import { join } from 'node:path';

// README §6.1: o domínio não depende de ORM nem de NestJS (nem do AWS SDK).
// Pega `from '@x/...'`, `import '@x/...'`, `import('@x/...')` e `require('@x/...')`.
const FORBIDDEN = /(from|import|require)\s*\(?\s*['"]@(nestjs|mikro-orm|aws-sdk)(\/|['"])/;

test('a regex pega todas as formas de import', () => {
  for (const line of [`import { X } from '@nestjs/common'`, `import '@mikro-orm/core'`, `await import('@aws-sdk/client-sqs')`, `require("@nestjs/core")`, `export * from '@mikro-orm/core'`]) {
    expect(FORBIDDEN.test(line)).toBe(true);
  }
});

test('src/domain não importa @nestjs, @mikro-orm nem @aws-sdk', async () => {
  const root = join(import.meta.dir, '../../..'); // independe do diretório de onde o teste roda
  const files = await Array.fromAsync(new Glob('src/domain/**/*.ts').scan(root));
  expect(files.length).toBeGreaterThan(0);
  const offenders = [];
  for (const file of files) {
    if (FORBIDDEN.test(await Bun.file(join(root, file)).text())) offenders.push(file);
  }
  expect(offenders).toEqual([]);
});
