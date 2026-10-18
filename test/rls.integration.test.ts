import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../src/db/client.js';
import { createDb, withContext, type Db } from '../src/db/context.js';
import { migrateUp } from '../src/db/migrator.js';
import { provisionLoginRole } from '../src/db/roles.js';
import { KIND, SEED_IDS, seedDatabase, uid } from '../src/db/seed.js';
import { resetDatabase, startDatabase, type TestDatabase } from './helpers/database.js';

/**
 * Estes testes conectam com o papel `app_api` (grupo `app_runtime`), SEM
 * `BYPASSRLS`. O usuário padrão do container é superusuário e ignora o RLS, então
 * só um papel real prova a barreira (ADR 0011).
 */

let database: TestDatabase;
let appPool: pg.Pool;
let db: Db;

const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const C = SEED_IDS.storeC;

async function count(table: string, context: Parameters<typeof withContext>[1], where = 'true') {
  return withContext(db, context, async (tx) => {
    const result = await tx.execute<{ n: string }>(
      sql.raw(`SELECT count(*) AS n FROM ${table} WHERE ${where}`),
    );
    return Number(result.rows[0]?.n);
  });
}

beforeAll(async () => {
  database = await startDatabase();
  await resetDatabase(database.pool);
  await migrateUp(database.pool, 'migrations');
  await seedDatabase(database.pool);
  await provisionLoginRole(database.pool, { name: 'app_api', password: 'senha-de-teste' });

  const url = new URL(database.uri);
  url.username = 'app_api';
  url.password = 'senha-de-teste';
  appPool = createPool(url.toString());
  db = createDb(appPool);
});

afterAll(async () => {
  await appPool.end();
  await database.stop();
});

describe('o papel do Backend em execução', () => {
  it('não é superusuário e não ignora o RLS', async () => {
    const result = await database.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_api'",
    );
    expect(result.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('não enxerga tabelas fora da lista de privilégios', async () => {
    await expect(appPool.query('SELECT * FROM schema_migrations')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('não apaga lance nem usuário', async () => {
    await expect(
      withContext(db, { storeId: A }, (tx) => tx.execute(sql`DELETE FROM bids`)),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(appPool.query('DELETE FROM users')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('sem contexto, nada de loja aparece (negar por padrão)', () => {
  it.each(['customers', 'cards_inventory', 'auctions', 'bids', 'settlements', 'settlement_items'])(
    'a tabela %s devolve zero linhas',
    async (table) => {
      expect(await count(table, {})).toBe(0);
    },
  );

  it('lojas, equipe e a credencial do WhatsApp também ficam invisíveis', async () => {
    expect(await count('stores', {})).toBe(0);
    expect(await count('store_members', {})).toBe(0);
    expect(await count('whatsapp_sessions', {})).toBe(0);
  });

  it('as tabelas de autenticação continuam acessíveis (login acontece antes da loja)', async () => {
    expect(await count('users', {})).toBeGreaterThan(0);
  });
});

describe('com o contexto de uma loja, só ela aparece', () => {
  it('lê só os dados da loja A', async () => {
    expect(await count('customers', { storeId: A })).toBe(40);
    expect(await count('customers', { storeId: A }, `store_id = '${B}'`)).toBe(0);
    expect(await count('customers', { storeId: B })).toBe(5);
    expect(await count('cards_inventory', { storeId: C })).toBe(2);
  });

  it('a credencial do WhatsApp só aparece para a própria loja', async () => {
    expect(await count('whatsapp_sessions', { storeId: A })).toBe(1);
    expect(await count('whatsapp_sessions', { storeId: B })).toBe(0);
  });

  it('não grava linha de outra loja (WITH CHECK)', async () => {
    await expect(
      withContext(db, { storeId: A }, (tx) =>
        tx.execute(
          sql`INSERT INTO customers (store_id, phone, name) VALUES (${B}, '5599999999999', 'Intruso')`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('não altera nem apaga linha de outra loja (zero linhas afetadas)', async () => {
    const result = await withContext(db, { storeId: A }, (tx) =>
      tx.execute(sql`UPDATE customers SET name = 'Hackeado' WHERE store_id = ${B}`),
    );
    expect(result.rowCount).toBe(0);
    const del = await withContext(db, { storeId: A }, (tx) =>
      tx.execute(sql`DELETE FROM customers WHERE store_id = ${B}`),
    );
    expect(del.rowCount).toBe(0);
    expect(await count('customers', { storeId: B }, "name = 'Hackeado'")).toBe(0);
  });

  it('rejeita contexto malformado antes de chegar ao banco', async () => {
    await expect(
      withContext(db, { storeId: "x' OR '1'='1" }, () => Promise.resolve(1)),
    ).rejects.toThrow('storeId inválido');
  });
});

describe('lojas e equipe por usuário', () => {
  it('o dono vê as duas lojas dele e a outra loja fica fora', async () => {
    const ctx = { userId: SEED_IDS.userOwner };
    expect(await count('stores', ctx)).toBe(2);
    expect(await count('stores', ctx, `id = '${C}'`)).toBe(0);
    expect(await count('store_members', ctx)).toBe(2);
  });

  it('o funcionário vê só a loja dele', async () => {
    const ctx = { userId: SEED_IDS.userStaff };
    expect(await count('stores', ctx)).toBe(1);
    expect(await count('stores', ctx, `id = '${A}'`)).toBe(1);
  });

  it('criar loja exige definir o contexto com o id novo', async () => {
    const id = uid(KIND.store, 900);
    await expect(
      withContext(db, { userId: SEED_IDS.userOwner }, (tx) =>
        tx.execute(sql`INSERT INTO stores (id, name) VALUES (${id}, 'Sem contexto')`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });

    await withContext(db, { userId: SEED_IDS.userOwner, storeId: id }, async (tx) => {
      await tx.execute(sql`INSERT INTO stores (id, name) VALUES (${id}, 'Loja nova')`);
      await tx.execute(
        sql`INSERT INTO store_members (store_id, user_id, role)
            VALUES (${id}, ${SEED_IDS.userOwner}, 'OWNER')`,
      );
    });
    expect(await count('stores', { userId: SEED_IDS.userOwner })).toBe(3);
  });

  it('o contexto de uma loja não permite criar loja com outro id', async () => {
    await expect(
      withContext(db, { storeId: A }, (tx) =>
        tx.execute(sql`INSERT INTO stores (id, name) VALUES (${uid(KIND.store, 901)}, 'Outra')`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('fronteira do administrador da plataforma (ADR 0012)', () => {
  const admin = { userId: SEED_IDS.userAdmin, isPlatformAdmin: true };

  it('lê lojas e equipe de todas as lojas', async () => {
    expect(await count('stores', admin)).toBeGreaterThanOrEqual(3);
    expect(await count('store_members', admin)).toBeGreaterThanOrEqual(4);
  });

  it.each([
    'customers',
    'cards_inventory',
    'auctions',
    'bids',
    'settlements',
    'settlement_items',
    'whatsapp_sessions',
  ])('NÃO enxerga %s de nenhuma loja', async (table) => {
    expect(await count(table, admin)).toBe(0);
  });

  it('NÃO grava dados internos de uma loja', async () => {
    await expect(
      withContext(db, admin, (tx) =>
        tx.execute(
          sql`INSERT INTO customers (store_id, phone, name) VALUES (${A}, '5588888888888', 'Via admin')`,
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('cria loja e a primeira associação do proprietário', async () => {
    const id = uid(KIND.store, 902);
    await withContext(db, admin, async (tx) => {
      await tx.execute(sql`INSERT INTO stores (id, name) VALUES (${id}, 'Criada pelo admin')`);
      await tx.execute(
        sql`INSERT INTO store_members (store_id, user_id, role)
            VALUES (${id}, ${SEED_IDS.userOtherOwner}, 'OWNER')`,
      );
    });
    expect(await count('stores', admin, `id = '${id}'`)).toBe(1);
  });

  it('um usuário comum não ganha poderes de administrador só por dizer', async () => {
    // Defesa em profundidade: o flag vem do Backend, que o valida no login.
    // Sem o flag, o mesmo usuário não vê lojas alheias.
    expect(await count('stores', { userId: SEED_IDS.userStaff }, `id = '${B}'`)).toBe(0);
  });
});
