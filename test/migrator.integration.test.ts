import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { checkDatabase, createPool } from '../src/db/client.js';
import {
  createMigration,
  loadMigrations,
  migrateDown,
  migrateUp,
  migrationStatus,
} from '../src/db/migrator.js';

const realDir = path.resolve('migrations');

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

async function hasTrgm(): Promise<boolean> {
  const result = await pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'");
  return result.rowCount === 1;
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  pool = createPool(container.getConnectionUri());
});

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  // Cada teste começa de um banco vazio.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await pool.query('DROP EXTENSION IF EXISTS pg_trgm');
});

describe('migrator com Postgres real', () => {
  it('aplica, reverte e reaplica as migrations do repositório', async () => {
    expect(await migrateUp(pool, realDir)).toEqual(['0001_extensoes']);
    expect(await hasTrgm()).toBe(true);

    expect(await migrateDown(pool, realDir)).toEqual(['0001_extensoes']);
    expect(await hasTrgm()).toBe(false);

    expect(await migrateUp(pool, realDir)).toEqual(['0001_extensoes']);
    expect(await hasTrgm()).toBe(true);
  });

  it('é idempotente: rodar duas vezes não reaplica', async () => {
    await migrateUp(pool, realDir);

    expect(await migrateUp(pool, realDir)).toEqual([]);
    expect(await migrationStatus(pool, realDir)).toEqual([{ id: '0001_extensoes', applied: true }]);
  });

  it('recusa uma migration já aplicada que foi editada', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    await cp(realDir, dir, { recursive: true });
    await migrateUp(pool, dir);

    await writeFile(path.join(dir, '0001_extensoes', 'up.sql'), 'SELECT 1;\n');

    await expect(migrateUp(pool, dir)).rejects.toThrow('foi editada');
  });

  it('desfaz a transação inteira quando uma migration falha', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    const id = await createMigration(dir, 'quebrada');
    await writeFile(path.join(dir, id, 'up.sql'), 'CREATE TABLE ok (id int); SELECT boom();');

    await expect(migrateUp(pool, dir)).rejects.toThrow();

    const tables = await pool.query("SELECT 1 FROM pg_tables WHERE tablename = 'ok'");
    expect(tables.rowCount).toBe(0);
    expect(await migrationStatus(pool, dir)).toEqual([{ id, applied: false }]);
  });

  it('cria migrations numeradas em sequência e valida o nome', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));

    expect(await createMigration(dir, 'cria-lojas')).toBe('0001_cria-lojas');
    expect(await createMigration(dir, 'cria-clientes')).toBe('0002_cria-clientes');
    expect((await loadMigrations(dir)).map((m) => m.id)).toEqual([
      '0001_cria-lojas',
      '0002_cria-clientes',
    ]);
    await expect(createMigration(dir, 'Nome Inválido')).rejects.toThrow('Nome inválido');
  });
});

describe('GET /ready contra o banco real', () => {
  it('responde 200 com o banco no ar e 503 depois de fechar o pool', async () => {
    const ownPool = createPool(container.getConnectionUri());
    const app = await buildApp({
      env: { logLevel: 'silent', serviceName: 'test' },
      checkDatabase: () => checkDatabase(ownPool),
    });

    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(200);

    await ownPool.end();

    expect((await app.inject({ method: 'GET', url: '/ready' })).statusCode).toBe(503);
    await app.close();
  });
});
