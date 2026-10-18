import { Queue, Worker } from 'bullmq';
import { sql } from 'drizzle-orm';

import type { Db } from '../db/context.js';
import { parseRedisUrl } from './redis.js';

export const MAINTENANCE_QUEUE = 'maintenance';
export const MAINTENANCE_PURGE_JOB = 'purge-expired';
/** Todo dia às 04:30, no horário de Brasília (depois do sync do catálogo, das 03:00). */
export const MAINTENANCE_PURGE_CRON = '30 4 * * *';
export const MAINTENANCE_TZ = 'America/Sao_Paulo';

export interface PurgeSummary {
  sessions: number;
  otps_cleared: number;
  ip_failures: number;
  public_links: number;
  invitations: number;
  catalog_runs: number;
}

/**
 * Apaga o que venceu e é só técnico (sessões, códigos de login, falhas por IP, links públicos e
 * convites antigos, execuções do sync). Dado pessoal de cliente e pedidos de acesso ficam de fora até a
 * decisão de retenção (LGPD). Idempotente: rodar a mais não apaga nada além do que já venceu.
 */
export async function purgeExpired(db: Db): Promise<PurgeSummary> {
  const result = await db.execute<{ summary: PurgeSummary }>(
    sql`SELECT purge_expired() AS summary`,
  );
  const summary = result.rows[0]?.summary;
  if (summary === undefined) throw new Error('purge_expired não devolveu resultado');
  return summary;
}

interface Log {
  info: (o: Record<string, unknown>, m: string) => void;
  warn: (o: Record<string, unknown>, m: string) => void;
}

/** Agenda a limpeza diária no BullMQ (persistente no Redis: reiniciar a API não duplica nem perde). */
export async function startMaintenanceJobs(options: {
  redisUrl: string;
  db: Db;
  log: Log;
}): Promise<{ close: () => Promise<void> }> {
  const { db, log } = options;
  const connection = parseRedisUrl(options.redisUrl);
  const queue = new Queue(MAINTENANCE_QUEUE, { connection });
  await queue.upsertJobScheduler(
    MAINTENANCE_PURGE_JOB,
    { pattern: MAINTENANCE_PURGE_CRON, tz: MAINTENANCE_TZ },
    {
      name: MAINTENANCE_PURGE_JOB,
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 100,
      },
    },
  );

  const worker = new Worker(
    MAINTENANCE_QUEUE,
    async () => {
      const summary = await purgeExpired(db);
      log.info({ ...summary }, 'limpeza: dados vencidos apagados');
      return summary;
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    log.warn(
      { job: job?.name, attempt: job?.attemptsMade, error: err.message },
      'job de limpeza falhou',
    );
  });
  worker.on('error', (err) => {
    log.warn({ error: err.message }, 'worker de limpeza com erro');
  });

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
