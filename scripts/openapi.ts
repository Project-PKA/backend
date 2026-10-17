// Gera docs/api/openapi.yaml A PARTIR DO CÓDIGO (make openapi).
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { buildApp } from '../src/app.js';
import { MemoryEmailSender } from '../src/auth/email.js';
import { loadEnv } from '../src/config/env.js';
import { createPool } from '../src/db/client.js';
import { createDb } from '../src/db/context.js';

const target = path.resolve('docs/api/openapi.yaml');

// Gerar o contrato não conecta em banco nem usa segredo: os valores abaixo são
// só para passar na validação do ambiente.
const env = loadEnv({
  APP_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://openapi:openapi@127.0.0.1:1/openapi',
  JWT_ACCESS_SECRET: 'openapi-nao-e-segredo-0123456789abcdef',
  REFRESH_TOKEN_PEPPER: 'openapi-nao-e-segredo-0123456789abcdef',
  OTP_HASH_SECRET: 'openapi-nao-e-segredo-0123456789abcdef',
});
const pool = createPool(env.databaseUrl);

const { app } = await buildApp({
  env,
  db: createDb(pool),
  email: new MemoryEmailSender(),
  checkDatabase: () => Promise.resolve(),
});
await app.ready();

const document = app.swagger({ yaml: true });
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, document);
await app.close();
await pool.end();

console.log(`Contrato gravado em ${path.relative(process.cwd(), target)}`);
