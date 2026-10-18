// Roda a limpeza de dados vencidos uma vez, na mão:
//
//   npm run maintenance:purge
import { loadEnv } from '../config/env.js';
import { createPool } from '../db/client.js';
import { createDb } from '../db/context.js';
import { purgeExpired } from './maintenance.js';

const env = loadEnv();
const pool = createPool(env.databaseUrl);
try {
  console.log('Limpeza concluída:', await purgeExpired(createDb(pool)));
} finally {
  await pool.end();
}
