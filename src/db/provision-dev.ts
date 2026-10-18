// Cria o usuário de LOGIN do Backend em desenvolvimento (sem BYPASSRLS), para o
// RLS valer também no `make run`. Em homolog e prod a provisão é feita à mão,
// com senha vinda dos secrets (docs/secrets.md).
import { createPool } from './client.js';
import { provisionRuntimeRoles } from './roles.js';

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

const bot = {
  name: process.env['DEV_BOT_ROLE'] ?? 'bot_api',
  password: process.env['DEV_BOT_PASSWORD'] ?? 'bot_api',
};

const pool = createPool(url);
try {
  const done = await provisionRuntimeRoles(pool, { app: { name, password }, bot });
  console.log(done.join('\n'));
} finally {
  await pool.end();
}
