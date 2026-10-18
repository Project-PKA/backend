import { Queue, Worker } from 'bullmq';

import { syncCatalog } from '../catalog/sync.js';
import type { TcgdexClient } from '../catalog/tcgdex.js';
import type { Db } from '../db/context.js';
import { parseRedisUrl } from './redis.js';

export const CATALOG_QUEUE = 'catalog';
export const CATALOG_SYNC_JOB = 'catalog-sync';
/** Todo dia às 03:00, no horário de Brasília (ADR 0009). */
export const CATALOG_SYNC_CRON = '0 3 * * *';
export const CATALOG_SYNC_TZ = 'America/Sao_Paulo';

interface Log {
  info: (o: Record<string, unknown>, m: string) => void;
  warn: (o: Record<string, unknown>, m: string) => void;
}

export interface CatalogJobsOptions {
  redisUrl: string;
  db: Db;
  client: TcgdexClient;
  languages: string[];
  log: Log;
}

export interface CatalogJobs {
  /** Falha se o Redis não responder (usado no /ready). */
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

/**
 * Agenda o sync noturno do catálogo e roda o worker. O agendamento mora no Redis (persistente), então
 * reiniciar a API não duplica nem perde a execução; várias instâncias dividem a mesma fila.
 * Três tentativas com espera crescente: o TCGdex fora do ar por alguns minutos não derruba o dia.
 */
export async function startCatalogJobs(options: CatalogJobsOptions): Promise<CatalogJobs> {
  const { db, client, languages, log } = options;
  const connection = parseRedisUrl(options.redisUrl);
  const queue = new Queue(CATALOG_QUEUE, { connection });
  await queue.upsertJobScheduler(
    CATALOG_SYNC_JOB,
    { pattern: CATALOG_SYNC_CRON, tz: CATALOG_SYNC_TZ },
    {
      name: CATALOG_SYNC_JOB,
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 100,
      },
    },
  );

  const worker = new Worker(
    CATALOG_QUEUE,
    async () => syncCatalog({ db, client, languages, log }),
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    log.warn({ job: job?.name, attempt: job?.attemptsMade, error: err.message }, 'job falhou');
  });
  worker.on('error', (err) => {
    log.warn({ error: err.message }, 'worker do catálogo com erro');
  });

  return {
    ping: async () => {
      await queue.getJobCounts('waiting');
    },
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
