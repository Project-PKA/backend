import { Queue, Worker } from 'bullmq';

import type { AuctionService } from '../auctions/service.js';
import { parseRedisUrl } from './redis.js';

export const AUCTIONS_QUEUE = 'auctions';
export const AUCTIONS_ADVANCE_JOB = 'auctions-advance';
/** De minuto em minuto: é a precisão com que um leilão abre e fecha. */
export const AUCTIONS_ADVANCE_EVERY_MS = 60_000;

interface Log {
  info: (o: Record<string, unknown>, m: string) => void;
  warn: (o: Record<string, unknown>, m: string) => void;
}

export interface AuctionJobsOptions {
  redisUrl: string;
  auctions: AuctionService;
  log: Log;
}

/**
 * Abre e encerra os leilões de todas as lojas no horário (`advance_auctions`). A função do banco é
 * idempotente, então rodar a mais (várias instâncias, atraso) não causa dano. Sem tentativas extras:
 * a próxima rodada, um minuto depois, faz o mesmo trabalho.
 */
export async function startAuctionJobs(
  options: AuctionJobsOptions,
): Promise<{ close: () => Promise<void> }> {
  const { auctions, log } = options;
  const connection = parseRedisUrl(options.redisUrl);
  const queue = new Queue(AUCTIONS_QUEUE, { connection });
  await queue.upsertJobScheduler(
    AUCTIONS_ADVANCE_JOB,
    { every: AUCTIONS_ADVANCE_EVERY_MS },
    {
      name: AUCTIONS_ADVANCE_JOB,
      opts: { attempts: 1, removeOnComplete: 5, removeOnFail: 20 },
    },
  );

  const worker = new Worker(
    AUCTIONS_QUEUE,
    async () => {
      const summary = await auctions.advanceAll();
      if (summary.opened > 0 || summary.finished > 0 || summary.failed > 0) {
        log.info({ ...summary }, 'leilões: relógio virado');
      }
      return summary;
    },
    { connection, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    log.warn({ job: job?.name, error: err.message }, 'job de leilões falhou');
  });
  worker.on('error', (err) => {
    log.warn({ error: err.message }, 'worker de leilões com erro');
  });

  return {
    close: async () => {
      await worker.close();
      await queue.close();
    },
  };
}
