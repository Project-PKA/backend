import { createPool } from './client.js';
import { seedDatabase } from './seed.js';

const url = process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  throw new Error('Defina MIGRATION_DATABASE_URL (ou DATABASE_URL) com o usuário dono do schema');
}

// O seed apaga os dados antes de inserir: nunca roda fora de desenvolvimento.
const appEnv = process.env['APP_ENV'] ?? 'local';
if (!['local', 'dev', 'test'].includes(appEnv)) {
  throw new Error(`Seed recusado em APP_ENV=${appEnv}. Só roda em local, dev ou test.`);
}

const pool = createPool(url);
try {
  await seedDatabase(pool, process.env['CPF_ENCRYPTION_KEY'] ?? undefined);
  console.log('Seed aplicado.');
} finally {
  await pool.end();
}
