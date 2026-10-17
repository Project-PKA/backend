// Gera docs/api/openapi.yaml A PARTIR DO CÓDIGO (make openapi).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildApp } from '../src/app.js';

const target = path.resolve('docs/api/openapi.yaml');

const app = await buildApp({
  env: { logLevel: 'silent', serviceName: 'openapi' },
  // Gerar o contrato não precisa de banco.
  checkDatabase: () => Promise.resolve(),
});
await app.ready();

const document = app.swagger({ yaml: true });
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, document);
await app.close();

console.log(`Contrato gravado em ${path.relative(process.cwd(), target)}`);
