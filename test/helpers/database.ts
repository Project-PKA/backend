import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';

import { createPool } from '../../src/db/client.js';

export interface TestDatabase {
  pool: pg.Pool;
  uri: string;
  stop: () => Promise<void>;
}

/** Sobe um Postgres descartável (container) e devolve um pool conectado a ele. */
export async function startDatabase(): Promise<TestDatabase> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:17-alpine',
  ).start();
  const pool = createPool(container.getConnectionUri());
  return {
    pool,
    uri: container.getConnectionUri(),
    stop: async () => {
      await pool.end();
      await container.stop();
    },
  };
}

/** Esvazia o banco inteiro (schema e extensões), para cada teste começar do zero. */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query('DROP EXTENSION IF EXISTS pg_trgm');
}
