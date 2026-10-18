import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type pg from 'pg';

/**
 * Migrations numeradas e reversíveis: migrations/NNNN_nome/{up,down}.sql.
 * O Drizzle não gera `down`, então cada par é escrito e testado à mão
 * (docs/database.md). Uma migration aplicada nunca é editada: o checksum
 * do `up.sql` é gravado e conferido.
 */

const DIR_PATTERN = /^(\d{4})_([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const ADVISORY_LOCK_ID = 727_274;

export interface Migration {
  id: string;
  upSql: string;
  downSql: string;
  checksum: string;
}

export interface MigrationStatus {
  id: string;
  applied: boolean;
}

function checksumOf(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export async function loadMigrations(dir: string): Promise<Migration[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isDirectory() && DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const numbers = ids.map((id) => Number(id.slice(0, 4)));
  numbers.forEach((number, index) => {
    if (number !== index + 1) {
      throw new Error(
        `Numeração de migrations quebrada em ${ids[index] ?? '?'}: esperado ${index + 1}`,
      );
    }
  });

  return Promise.all(
    ids.map(async (id) => {
      const upSql = await readFile(path.join(dir, id, 'up.sql'), 'utf-8');
      const downSql = await readFile(path.join(dir, id, 'down.sql'), 'utf-8');
      return { id, upSql, downSql, checksum: checksumOf(upSql) };
    }),
  );
}

async function withLock<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id TEXT PRIMARY KEY,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    return await work(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
    client.release();
  }
}

async function appliedChecksums(client: pg.PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ id: string; checksum: string }>(
    'SELECT id, checksum FROM schema_migrations ORDER BY id',
  );
  return new Map(result.rows.map((row) => [row.id, row.checksum]));
}

async function runInTransaction(client: pg.PoolClient, sql: string, after: () => Promise<unknown>) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await after();
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** Aplica as migrations pendentes e devolve os ids aplicados. */
export async function migrateUp(pool: pg.Pool, dir: string): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  return withLock(pool, async (client) => {
    const applied = await appliedChecksums(client);
    const done: string[] = [];
    for (const migration of migrations) {
      const recorded = applied.get(migration.id);
      if (recorded !== undefined) {
        if (recorded !== migration.checksum) {
          throw new Error(
            `A migration ${migration.id} já foi aplicada e foi editada. Crie uma migration nova.`,
          );
        }
        continue;
      }
      await runInTransaction(client, migration.upSql, () =>
        client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
          migration.id,
          migration.checksum,
        ]),
      );
      done.push(migration.id);
    }
    return done;
  });
}

/** Reverte as últimas `steps` migrations aplicadas e devolve os ids revertidos. */
export async function migrateDown(pool: pg.Pool, dir: string, steps = 1): Promise<string[]> {
  const migrations = await loadMigrations(dir);
  return withLock(pool, async (client) => {
    const applied = await appliedChecksums(client);
    const toRevert = migrations
      .filter((m) => applied.has(m.id))
      .reverse()
      .slice(0, steps);
    for (const migration of toRevert) {
      await runInTransaction(client, migration.downSql, () =>
        client.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]),
      );
    }
    return toRevert.map((m) => m.id);
  });
}

export async function migrationStatus(pool: pg.Pool, dir: string): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(dir);
  return withLock(pool, async (client) => {
    const applied = await appliedChecksums(client);
    return migrations.map((m) => ({ id: m.id, applied: applied.has(m.id) }));
  });
}

/** Cria migrations/NNNN_nome com `up.sql` e `down.sql` vazios (comentados). */
export async function createMigration(dir: string, name: string): Promise<string> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Nome inválido: "${name}". Use kebab-case em minúsculas, ex.: cria-lojas`);
  }
  await mkdir(dir, { recursive: true });
  const existing = await loadMigrations(dir);
  const id = `${String(existing.length + 1).padStart(4, '0')}_${name}`;
  const target = path.join(dir, id);
  await mkdir(target);
  await writeFile(path.join(target, 'up.sql'), `-- ${id}: aplica\n`);
  await writeFile(path.join(target, 'down.sql'), `-- ${id}: reverte (obrigatório)\n`);
  return id;
}
