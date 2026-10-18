import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createPool } from '../src/db/client.js';
import { startDatabase, type TestDatabase } from './helpers/database.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await startDatabase();
});

afterAll(async () => {
  await database.stop();
});

describe('createPool', () => {
  it('sobrevive a uma conexão ociosa derrubada pelo servidor e volta a consultar', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = createPool(database.uri);
    await pool.query('SELECT 1');

    // O servidor encerra a conexão ociosa (reinício do banco, container parado).
    await database.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE pid <> pg_backend_pid() AND application_name = '' AND state = 'idle'
          AND datname = current_database() AND usename = current_user`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Sem o ouvinte de erro isto seria um "Unhandled error" que derruba o processo.
    expect((await pool.query('SELECT 2 AS n')).rows[0]).toEqual({ n: 2 });
    expect(log.mock.calls.some(([line]) => String(line).includes('57P01'))).toBe(true);
    await pool.end();
    log.mockRestore();
  });
});
