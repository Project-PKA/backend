import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { checkDatabase, createPool } from './db/client.js';

const env = loadEnv();
const pool = createPool(env.databaseUrl);
const app = await buildApp({ env, checkDatabase: () => checkDatabase(pool) });

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.port, host: '0.0.0.0' });
