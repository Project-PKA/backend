import { buildApp } from './app.js';
import { LogEmailSender } from './auth/email.js';
import { loadEnv } from './config/env.js';
import { checkDatabase, createPool } from './db/client.js';
import { createDb } from './db/context.js';

const env = loadEnv();
const pool = createPool(env.databaseUrl);
const db = createDb(pool);

// O provedor "log" só existe em desenvolvimento (loadEnv recusa em homolog e prod).
// eslint-disable-next-line prefer-const -- o logger do app só existe depois de montá-lo
let built: Awaited<ReturnType<typeof buildApp>>;
const email = new LogEmailSender(() => built.app.log);
built = await buildApp({ env, db, email, checkDatabase: () => checkDatabase(pool) });
const { app, auth, invitations } = built;

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await Promise.all([auth.flush(), invitations.flush()]);
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.port, host: '0.0.0.0' });
