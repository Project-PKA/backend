// Cria o usuário de LOGIN do Backend em desenvolvimento (sem BYPASSRLS), para o
// RLS valer também no `make run`. Em homolog e prod a provisão é feita à mão,
// com senha vinda dos secrets (docs/secrets.md).
import { createPool } from './client.js';
import { provisionLoginRole } from './roles.js';

const appEnv = process.env['APP_ENV'] ?? 'local';
if (!['local', 'dev', 'test'].includes(appEnv)) {
  throw new Error(`provision-dev recusado em APP_ENV=${appEnv}. Só roda em local, dev ou test.`);
}

const url = process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  throw new Error('Defina MIGRATION_DATABASE_URL (ou DATABASE_URL) com o usuário dono do schema');
}

const name = process.env['DEV_API_ROLE'] ?? 'app_api';
const password = process.env['DEV_API_PASSWORD'] ?? 'app_api';

const pool = createPool(url);
try {
  await provisionLoginRole(pool, { name, password });
  console.log(`Papel de login "${name}" pronto (grupo app_runtime).`);
} finally {
  await pool.end();
}
