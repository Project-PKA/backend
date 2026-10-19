import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPool } from '../src/db/client.js';
import { migrateUp } from '../src/db/migrator.js';
import { assertNoPrivilege, provisionLoginRole, provisionRuntimeRoles } from '../src/db/roles.js';
import { SEED_IDS, seedDatabase } from '../src/db/seed.js';
import { resetDatabase, startDatabase, type TestDatabase } from './helpers/database.js';

/**
 * O papel do bot (`bot_runtime`, OWNER.md D15): conecta como um login de verdade, SEM BYPASSRLS, e
 * só chega ao mínimo, só na loja do contexto. O usuário padrão do container é superusuário e
 * ignora o RLS, então só um papel real prova a barreira (ADR 0011).
 */

let database: TestDatabase;
let bot: pg.Pool;
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
let auctionA = '';
let auctionB = '';
let customerA = '';
let customerB = '';

/** Roda como o bot, numa transação com a loja definida (ou sem contexto, se `store` for null). */
async function asBot<T>(
  store: string | null,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await bot.connect();
  try {
    await client.query('BEGIN');
    if (store !== null) await client.query("SELECT set_config('app.store_id', $1, true)", [store]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function insertAuction(store: string): Promise<string> {
  const card = await database.pool.query<{ id: string }>(
    `SELECT c.id FROM cards_inventory c
      WHERE c.store_id = $1 AND c.status = 'AVAILABLE'
        AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.card_id = c.id)
      ORDER BY c.short_code LIMIT 1`,
    [store],
  );
  const created = await database.pool.query<{ id: string }>(
    `INSERT INTO auctions (store_id, card_id, type, start_time, end_time, initial_bid, min_increment, status)
     VALUES ($1, $2, 'FREE_BID', now() - interval '1 hour', now() + interval '1 hour', 10, 1, 'ACTIVE')
     RETURNING id`,
    [store, card.rows[0]?.id],
  );
  return created.rows[0]?.id ?? '';
}

async function firstCustomer(store: string): Promise<string> {
  const result = await database.pool.query<{ id: string }>(
    'SELECT id FROM customers WHERE store_id = $1 AND NOT is_blacklisted ORDER BY id LIMIT 1',
    [store],
  );
  return result.rows[0]?.id ?? '';
}

beforeAll(async () => {
  database = await startDatabase();
  await resetDatabase(database.pool);
  await migrateUp(database.pool, 'migrations');
  await seedDatabase(database.pool);
  await provisionLoginRole(database.pool, {
    name: 'bot_api',
    password: 'senha-de-teste',
    group: 'bot_runtime',
  });
  const url = new URL(database.uri);
  url.username = 'bot_api';
  url.password = 'senha-de-teste';
  bot = createPool(url.toString());
  auctionA = await insertAuction(A);
  auctionB = await insertAuction(B);
  customerA = await firstCustomer(A);
  customerB = await firstCustomer(B);
});

afterAll(async () => {
  await bot.end();
  await database.stop();
});

describe('o papel do bot', () => {
  it('não é superusuário, não ignora o RLS e é só do grupo bot_runtime', async () => {
    const role = await database.pool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      groups: string[];
    }>(
      `SELECT r.rolsuper, r.rolbypassrls,
              coalesce(array_agg(g.rolname) FILTER (WHERE g.rolname IS NOT NULL), '{}')::text[] AS groups
         FROM pg_roles r
         LEFT JOIN pg_auth_members m ON m.member = r.oid
         LEFT JOIN pg_roles g ON g.oid = m.roleid
        WHERE r.rolname = 'bot_api' GROUP BY r.rolsuper, r.rolbypassrls`,
    );
    expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, groups: ['bot_runtime'] });
  });

  it('só enxerga a loja do contexto e nada sem contexto', async () => {
    const own = await asBot(A, (c) =>
      c.query<{ store_id: string }>('SELECT DISTINCT store_id FROM auctions'),
    );
    expect(own.rows.map((r) => r.store_id)).toEqual([A]);

    for (const table of ['auctions', 'bids', 'customers', 'cards_inventory', 'whatsapp_sessions']) {
      const none = await asBot(null, (c) => c.query(`SELECT 1 FROM ${table}`));
      expect(none.rowCount, table).toBe(0);
    }
  });

  it('não lê tabela fora da lista (permissão negada)', async () => {
    for (const table of [
      'users',
      'refresh_tokens',
      'invitations',
      'store_members',
      'settlements',
      'settlement_items',
      'public_links',
      'access_requests',
      'admin_activity_log',
      'activity_log',
      'notifications',
    ]) {
      await expect(
        asBot(A, (c) => c.query(`SELECT 1 FROM ${table}`)),
        table,
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('lê só as colunas liberadas de lojas, clientes e cartas', async () => {
    const stores = await asBot(null, (c) =>
      c.query('SELECT id, name, whatsapp_group_id, whatsapp_status FROM stores'),
    );
    expect(stores.rowCount).toBeGreaterThanOrEqual(2);

    await expect(asBot(A, (c) => c.query('SELECT pix_key FROM stores'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(asBot(A, (c) => c.query('SELECT cpf FROM customers'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(asBot(A, (c) => c.query('SELECT email FROM customers'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(asBot(A, (c) => c.query('SELECT * FROM customers'))).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      asBot(A, (c) => c.query('SELECT consignor_id FROM cards_inventory')),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('não escreve em lojas, não apaga lance nem cliente e não edita blacklist', async () => {
    const attempts = [
      `UPDATE stores SET name = 'x'`,
      `UPDATE stores SET whatsapp_status = 'ONLINE'`,
      `DELETE FROM bids`,
      `DELETE FROM customers`,
      `DELETE FROM auctions`,
      `UPDATE customers SET is_blacklisted = true`,
      `UPDATE customers SET name = 'x'`,
      `UPDATE bids SET amount = 1`,
      `UPDATE cards_inventory SET notes = 'x'`,
    ];
    for (const statement of attempts) {
      await expect(
        asBot(A, (c) => c.query(statement)),
        statement,
      ).rejects.toMatchObject({
        code: '42501',
      });
    }
  });
});

describe('o que o bot faz', () => {
  it('registra lance com place_bid e a regra do banco vale', async () => {
    const first = await asBot(A, (c) =>
      c.query<{ outcome: string }>('SELECT outcome FROM place_bid($1, $2, $3, 15, $4)', [
        A,
        auctionA,
        customerA,
        '#A1 15',
      ]),
    );
    expect(first.rows[0]?.outcome).toBe('ACCEPTED');

    const low = await asBot(A, (c) =>
      c.query<{ outcome: string }>('SELECT outcome FROM place_bid($1, $2, $3, 15, $4)', [
        A,
        auctionA,
        customerA,
        '#A1 15',
      ]),
    );
    expect(low.rows[0]?.outcome).toBe('BID_TOO_LOW');
  });

  it('place_bid de outra loja não enxerga o leilão', async () => {
    const crossed = await asBot(A, (c) =>
      c.query<{ outcome: string }>('SELECT outcome FROM place_bid($1, $2, $3, 99, $4)', [
        B,
        auctionB,
        customerB,
        '#B 99',
      ]),
    );
    expect(crossed.rows[0]?.outcome).toBe('AUCTION_NOT_FOUND');
    const stored = await database.pool.query('SELECT 1 FROM bids WHERE auction_id = $1', [
      auctionB,
    ]);
    expect(stored.rowCount).toBe(0);
  });

  it('advance_auctions encerra o leilão vencido e define o vencedor', async () => {
    const card = await database.pool.query<{ id: string }>(
      `SELECT c.id FROM cards_inventory c
        WHERE c.store_id = $1 AND c.status = 'AVAILABLE'
          AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.card_id = c.id)
        ORDER BY c.short_code LIMIT 1`,
      [A],
    );
    const expired = await database.pool.query<{ id: string }>(
      `INSERT INTO auctions (store_id, card_id, type, start_time, end_time, initial_bid, min_increment, status)
       VALUES ($1, $2, 'FREE_BID', now() - interval '2 hours', now() - interval '1 hour', 10, 1, 'ACTIVE')
       RETURNING id`,
      [A, card.rows[0]?.id],
    );
    const id = expired.rows[0]?.id ?? '';
    await database.pool.query(
      `INSERT INTO bids (store_id, auction_id, customer_id, amount, raw_whatsapp_message)
       VALUES ($1, $2, $3, 20, '#X 20')`,
      [A, id, customerA],
    );

    const advanced = await asBot(A, (c) =>
      c.query<{ finished: number }>('SELECT finished FROM advance_auctions($1)', [A]),
    );
    expect(advanced.rows[0]?.finished).toBeGreaterThanOrEqual(1);
    const row = await database.pool.query<{ status: string; winner: string | null }>(
      'SELECT status, winning_bid_id AS winner FROM auctions WHERE id = $1',
      [id],
    );
    expect(row.rows[0]?.status).toBe('FINISHED');
    expect(row.rows[0]?.winner).not.toBeNull();
  });

  it('cria o visitante no primeiro lance, só na própria loja e sem repetir o telefone', async () => {
    const created = await asBot(A, (c) =>
      c.query<{ id: string; is_visitor: boolean }>(
        `INSERT INTO customers (store_id, phone, name) VALUES ($1, '5599988877001', 'Novo') RETURNING id, is_visitor`,
        [A],
      ),
    );
    expect(created.rows[0]?.is_visitor).toBe(true);

    await expect(
      asBot(A, (c) =>
        c.query(
          `INSERT INTO customers (store_id, phone, name) VALUES ($1, '5599988877002', 'Fora')`,
          [B],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asBot(A, (c) =>
        c.query(
          `INSERT INTO customers (store_id, phone, name) VALUES ($1, '5599988877001', 'Repetido')`,
          [A],
        ),
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('guarda a sessão do WhatsApp só da própria loja', async () => {
    await asBot(A, (c) =>
      c.query(
        `INSERT INTO whatsapp_sessions (store_id, session_data) VALUES ($1, 'cifrado')
         ON CONFLICT (store_id) DO UPDATE SET session_data = EXCLUDED.session_data`,
        [A],
      ),
    );
    await expect(
      asBot(A, (c) =>
        c.query(`INSERT INTO whatsapp_sessions (store_id, session_data) VALUES ($1, 'x')`, [B]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const seen = await asBot(B, (c) => c.query('SELECT 1 FROM whatsapp_sessions'));
    expect(seen.rowCount).toBe(0);
  });
});

describe('bot_set_whatsapp_status', () => {
  const status = (store: string | null, target: string, value: string, group: string | null) =>
    asBot(store, (c) =>
      c.query<{ ok: boolean }>(
        'SELECT bot_set_whatsapp_status($1, $2::whatsapp_status, $3) AS ok',
        [target, value, group],
      ),
    );

  it('atualiza o estado e o grupo da loja do contexto', async () => {
    const result = await status(A, A, 'ONLINE', '120363025246125486@g.us');
    expect(result.rows[0]?.ok).toBe(true);
    const row = await database.pool.query<{ s: string; g: string }>(
      'SELECT whatsapp_status AS s, whatsapp_group_id AS g FROM stores WHERE id = $1',
      [A],
    );
    expect(row.rows[0]).toEqual({ s: 'ONLINE', g: '120363025246125486@g.us' });

    await status(A, A, 'OFFLINE', null);
    const kept = await database.pool.query<{ s: string; g: string }>(
      'SELECT whatsapp_status AS s, whatsapp_group_id AS g FROM stores WHERE id = $1',
      [A],
    );
    expect(kept.rows[0]).toEqual({ s: 'OFFLINE', g: '120363025246125486@g.us' });
  });

  it('recusa outra loja, sem contexto e id de grupo fora do formato', async () => {
    expect((await status(A, B, 'ONLINE', null)).rows[0]?.ok).toBe(false);
    expect((await status(null, A, 'ONLINE', null)).rows[0]?.ok).toBe(false);
    expect((await status(A, A, 'ONLINE', 'qualquer-coisa')).rows[0]?.ok).toBe(false);
    const row = await database.pool.query<{ s: string }>(
      'SELECT whatsapp_status AS s FROM stores WHERE id = $1',
      [B],
    );
    expect(row.rows[0]?.s).not.toBe('ONLINE');
  });
});

describe('provisão dos logins de runtime', () => {
  const secret = 'y'.repeat(24);

  it('cria o login da API e o do bot, cada um no seu grupo e sem privilégio demais', async () => {
    const done = await provisionRuntimeRoles(database.pool, {
      app: { name: 'api_provisionada', password: secret },
      bot: { name: 'bot_provisionado', password: secret },
    });
    expect(done).toHaveLength(2);
    const groups = await database.pool.query<{ member: string; grp: string }>(
      `SELECT m.rolname AS member, g.rolname AS grp
         FROM pg_auth_members am
         JOIN pg_roles m ON m.oid = am.member
         JOIN pg_roles g ON g.oid = am.roleid
        WHERE m.rolname IN ('api_provisionada', 'bot_provisionado')`,
    );
    expect(groups.rows).toEqual(
      expect.arrayContaining([
        { member: 'api_provisionada', grp: 'app_runtime' },
        { member: 'bot_provisionado', grp: 'bot_runtime' },
      ]),
    );
  });

  it('sem bot cria só o da API', async () => {
    const done = await provisionRuntimeRoles(database.pool, {
      app: { name: 'api_sozinha', password: secret },
      bot: null,
    });
    expect(done).toHaveLength(1);
  });

  it('recusa um papel com superusuário ou BYPASSRLS', async () => {
    const superuser = await database.pool.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolsuper LIMIT 1',
    );
    await expect(
      assertNoPrivilege(database.pool, superuser.rows[0]?.rolname ?? ''),
    ).rejects.toThrow('privilégio demais');
    await expect(assertNoPrivilege(database.pool, 'papel_que_nao_existe')).rejects.toThrow(
      'privilégio demais',
    );
  });
});
