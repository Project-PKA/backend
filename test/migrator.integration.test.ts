import { cp, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
import { resetDatabase, startDatabase, type TestDatabase } from './helpers/database.js';

const realDir = path.resolve('migrations');

let database: TestDatabase;

async function hasTrgm(): Promise<boolean> {
  const result = await database.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'");
  return result.rowCount === 1;
}

async function realIds(): Promise<string[]> {
  return (await loadMigrations(realDir)).map((m) => m.id);
}

beforeAll(async () => {
  database = await startDatabase();
});

afterAll(async () => {
  await database.stop();
});

beforeEach(async () => {
  await resetDatabase(database.pool);
});

describe('migrator com Postgres real', () => {
  it('aplica, reverte tudo e reaplica as migrations do repositório', async () => {
    const ids = await realIds();

    expect(await migrateUp(database.pool, realDir)).toEqual(ids);
    expect(await hasTrgm()).toBe(true);

    // Reverte na ordem inversa, até zerar.
    expect(await migrateDown(database.pool, realDir, ids.length)).toEqual([...ids].reverse());
    expect(await hasTrgm()).toBe(false);

    expect(await migrateUp(database.pool, realDir)).toEqual(ids);
  });

  it('não deixa tabela nem tipo para trás depois de reverter tudo', async () => {
    const ids = await realIds();
    await migrateUp(database.pool, realDir);
    await migrateDown(database.pool, realDir, ids.length);

    const tables = await database.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
    );
    const enums = await database.pool.query("SELECT 1 FROM pg_type WHERE typtype = 'e'");

    expect(tables.rows.map((row) => row.tablename)).toEqual(['schema_migrations']);
    expect(enums.rowCount).toBe(0);
  });

  it('é idempotente: rodar duas vezes não reaplica', async () => {
    const ids = await realIds();
    await migrateUp(database.pool, realDir);

    expect(await migrateUp(database.pool, realDir)).toEqual([]);
    expect(await migrationStatus(database.pool, realDir)).toEqual(
      ids.map((id) => ({ id, applied: true })),
    );
  });

  it('recusa uma migration já aplicada que foi editada', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    await cp(realDir, dir, { recursive: true });
    await migrateUp(database.pool, dir);

    await writeFile(path.join(dir, '0001_extensoes', 'up.sql'), 'SELECT 1;\n');

    await expect(migrateUp(database.pool, dir)).rejects.toThrow('foi editada');
  });

  it('desfaz a transação inteira quando uma migration falha', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    const id = await createMigration(dir, 'quebrada');
    await writeFile(path.join(dir, id, 'up.sql'), 'CREATE TABLE ok (id int); SELECT boom();');

    await expect(migrateUp(database.pool, dir)).rejects.toThrow();

    const tables = await database.pool.query("SELECT 1 FROM pg_tables WHERE tablename = 'ok'");
    expect(tables.rowCount).toBe(0);
    expect(await migrationStatus(database.pool, dir)).toEqual([{ id, applied: false }]);
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
    const ownPool = createPool(database.uri);
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
