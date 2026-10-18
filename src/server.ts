import { buildApp } from './app.js';
import { LogEmailSender } from './auth/email.js';
import { loadEnv } from './config/env.js';
import { checkDatabase, createPool } from './db/client.js';
import { createTcgdexClient } from './catalog/tcgdex.js';
import { createDb } from './db/context.js';
import { startAuctionJobs } from './jobs/auctions.js';
import { startMaintenanceJobs } from './jobs/maintenance.js';
import { startCatalogJobs, type CatalogJobs } from './jobs/catalog.js';

const env = loadEnv();
const pool = createPool(env.databaseUrl);
const db = createDb(pool);

// O provedor "log" só existe em desenvolvimento (loadEnv recusa em homolog e prod).
// eslint-disable-next-line prefer-const -- o logger do app só existe depois de montá-lo
let built: Awaited<ReturnType<typeof buildApp>>;
const email = new LogEmailSender(() => built.app.log);
let jobs: CatalogJobs | undefined;
let auctionJobs: { close: () => Promise<void> } | undefined;
let maintenanceJobs: { close: () => Promise<void> } | undefined;
built = await buildApp({
  env,
  db,
  email,
  checkDatabase: async () => {
    await checkDatabase(pool);
    await jobs?.ping();
  },
});
const { app, auth, invitations, auctions } = built;
if (env.redisUrl === null) {
  app.log.warn(
    'REDIS_URL ausente: o sync do catálogo e a virada dos leilões no horário não estão agendados',
  );
} else {
  const jobLog = {
    info: (o: Record<string, unknown>, m: string) => {
      app.log.info(o, m);
    },
    warn: (o: Record<string, unknown>, m: string) => {
      app.log.warn(o, m);
    },
  };
  auctionJobs = await startAuctionJobs({ redisUrl: env.redisUrl, auctions, log: jobLog });
  maintenanceJobs = await startMaintenanceJobs({ redisUrl: env.redisUrl, db, log: jobLog });
  jobs = await startCatalogJobs({
    redisUrl: env.redisUrl,
    db,
    client: createTcgdexClient(),
    languages: env.catalogLanguages,
    log: jobLog,
  });
}

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'encerrando');
  await app.close();
  await jobs?.close();
  await auctionJobs?.close();
  await maintenanceJobs?.close();
  await Promise.all([auth.flush(), invitations.flush()]);
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: env.port, host: '0.0.0.0' });
