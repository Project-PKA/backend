import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrateUp } from '../src/db/migrator.js';
import * as schema from '../src/db/schema.js';
import { KIND, SEED_IDS, seedDatabase, uid } from '../src/db/seed.js';
import { resetDatabase, startDatabase, type TestDatabase } from './helpers/database.js';

const migrationsDir = path.resolve('migrations');

let database: TestDatabase;

const schemaTables: PgTable[] = Object.values(schema).flatMap((value) =>
  is(value, PgTable) ? [value] : [],
);

const normalizeType = (type: string): string => type.replaceAll(' ', '');

beforeAll(async () => {
  database = await startDatabase();
  await resetDatabase(database.pool);
  await migrateUp(database.pool, migrationsDir);
  await seedDatabase(database.pool);
});

afterAll(async () => {
  await database.stop();
});

async function count(table: string, where = 'true'): Promise<number> {
  const result = await database.pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} WHERE ${where}`,
  );
  return Number(result.rows[0]?.n);
}

async function distinct(table: string, column: string): Promise<string[]> {
  const result = await database.pool.query<{ value: string }>(
    `SELECT DISTINCT ${column}::text AS value FROM ${table} ORDER BY 1`,
  );
  return result.rows.map((row) => row.value);
}

describe('arquivos de migration', () => {
  it('são UTF-8 válido, sem BOM', async () => {
    const dirs = (await readdir(migrationsDir, { withFileTypes: true })).filter((e) =>
      e.isDirectory(),
    );
    for (const dir of dirs) {
      for (const file of ['up.sql', 'down.sql']) {
        const bytes = await readFile(path.join(migrationsDir, dir.name, file));
        expect(bytes.subarray(0, 3).toString('hex'), `${dir.name}/${file}`).not.toBe('efbbbf');
        expect(() => new TextDecoder('utf-8', { fatal: true }).decode(bytes)).not.toThrow();
      }
    }
  });
});

describe('schema.ts contra o banco migrado (drift)', () => {
  it('tem exatamente as mesmas tabelas do banco', async () => {
    const result = await database.pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'",
    );
    const inDatabase = result.rows.map((row) => row.tablename).sort((a, b) => a.localeCompare(b));
    const inSchema = schemaTables
      .map((table) => getTableConfig(table).name)
      .sort((a, b) => a.localeCompare(b));

    expect(inSchema).toEqual(inDatabase);
  });

  it.each(schemaTables.map((table) => [getTableConfig(table).name, table] as const))(
    'a tabela %s tem as mesmas colunas, tipos e nulabilidade',
    async (name, table) => {
      const result = await database.pool.query<{ name: string; type: string; not_null: boolean }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
                a.attnotnull AS not_null
           FROM pg_attribute a
           JOIN pg_class c ON c.oid = a.attrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped
          ORDER BY a.attname`,
        [name],
      );
      const inDatabase = result.rows.map((row) => ({
        name: row.name,
        type: normalizeType(row.type),
        notNull: row.not_null,
      }));
      const inSchema = getTableConfig(table)
        .columns.map((column) => ({
          name: column.name,
          type: normalizeType(column.getSQLType()),
          notNull: column.notNull,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      expect(inSchema).toEqual(inDatabase);
    },
  );
});

describe('seed', () => {
  it('é determinístico: rodar de novo dá exatamente o mesmo banco', async () => {
    const snapshot = async (): Promise<string[]> => {
      const rows: string[] = [];
      for (const table of schemaTables
        .map((t) => getTableConfig(t).name)
        .sort((a, b) => a.localeCompare(b))) {
        const result = await database.pool.query<{ digest: string }>(
          `SELECT md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS digest FROM ${table} t`,
        );
        rows.push(`${table}:${result.rows[0]?.digest ?? ''}`);
      }
      return rows;
    };

    const first = await snapshot();
    await seedDatabase(database.pool);

    expect(await snapshot()).toEqual(first);
  });

  it('cobre cada estado de cada entidade', async () => {
    expect(await distinct('cards_inventory', 'status')).toEqual([
      'AVAILABLE',
      'AWAITING_CONFIRMATION',
      'SCHEDULED',
      'SOLD',
    ]);
    expect(await distinct('cards_inventory', 'ownership_type')).toEqual(['CONSIGNED', 'OWN']);
    expect(await distinct('cards_inventory', 'condition')).toHaveLength(6);
    expect(await distinct('auctions', 'status')).toEqual([
      'ACTIVE',
      'CANCELLED',
      'FINISHED',
      'PAUSED_FOR_VALIDATION',
      'PENDING',
    ]);
    expect(await distinct('auctions', 'type')).toEqual(['FREE_BID', 'POLL']);
    expect(await distinct('settlements', 'status')).toEqual(['PAID', 'PENDING']);
    expect(await distinct('store_members', 'role')).toEqual(['OWNER', 'STAFF']);
    expect(await distinct('users', 'status')).toEqual(['ACTIVE', 'INVITED', 'SUSPENDED']);
    expect(await distinct('invitations', 'status')).toEqual(['ACCEPTED', 'PENDING', 'REVOKED']);
    expect(await count('users', 'is_platform_admin')).toBe(1);
    expect(await count('users', 'can_create_stores AND store_limit > 0')).toBeGreaterThan(0);
    expect(await count('invitations', 'store_id IS NULL')).toBeGreaterThan(0);
    expect(await distinct('stores', 'whatsapp_status')).toEqual(['OFFLINE', 'ONLINE', 'QR_READY']);
    expect(await count('customers', 'is_visitor')).toBeGreaterThan(0);
    expect(await count('customers', 'is_blacklisted')).toBeGreaterThan(0);
    expect(await count('customers', 'NOT is_visitor AND NOT is_blacklisted')).toBeGreaterThan(0);
  });

  it('tem volume para paginar e dados de borda', async () => {
    expect(await count('customers', `store_id = '${SEED_IDS.storeA}'`)).toBeGreaterThan(20);
    expect(await count('cards_inventory', `store_id = '${SEED_IDS.storeA}'`)).toBeGreaterThan(20);
    expect(await count('customers', 'email IS NULL')).toBeGreaterThan(0);
    expect(await count('stores', "name ~ '[^\\x01-\\x7F]'")).toBeGreaterThan(0);
  });

  it('mantém o mesmo telefone e short_code em lojas diferentes', async () => {
    expect(await count('customers', "phone = '5511900000001'")).toBe(2);
    expect(await count('cards_inventory', "short_code = 'A1'")).toBe(2);
  });
});

describe('regras de integridade do banco', () => {
  const cardA = (n: number): string => uid(KIND.card, n);

  async function expectRejected(sql: string, params: unknown[], constraint: string) {
    await expect(database.pool.query(sql, params)).rejects.toMatchObject({ constraint });
  }

  const insertCard = `INSERT INTO cards_inventory
    (store_id, short_code, tcgdex_id, language, condition, ownership_type, consignor_id, store_commission_pct)
    VALUES ($1, $2, 'seed-001', 'PT', 'NM', $3, $4, $5)`;

  it('recusa short_code repetido na mesma loja', async () => {
    await expectRejected(
      insertCard,
      [SEED_IDS.storeA, 'A1', 'OWN', null, null],
      'cards_inventory_store_short_code_key',
    );
  });

  it('recusa consignador de outra loja', async () => {
    await expectRejected(
      insertCard,
      [SEED_IDS.storeB, 'ZZ1', 'CONSIGNED', uid(KIND.customer, 1), '10'],
      'cards_inventory_consignor_fkey',
    );
  });

  it('recusa carta consignada sem dono ou sem comissão, e própria com dono', async () => {
    await expectRejected(
      insertCard,
      [SEED_IDS.storeA, 'ZZ2', 'CONSIGNED', null, null],
      'cards_inventory_ownership_consistent',
    );
    await expectRejected(
      insertCard,
      [SEED_IDS.storeA, 'ZZ3', 'OWN', uid(KIND.customer, 1), '10'],
      'cards_inventory_ownership_consistent',
    );
  });

  it('recusa um segundo leilão em andamento para a mesma carta', async () => {
    await expectRejected(
      `INSERT INTO auctions (store_id, card_id, type, start_time, end_time, initial_bid, min_increment)
       VALUES ($1, $2, 'FREE_BID', '2098-02-01', '2098-02-02', 10, 1)`,
      [SEED_IDS.storeA, cardA(2)],
      'auctions_one_open_per_card_idx',
    );
  });

  it('recusa enquete sem teto, lance livre com teto e período invertido', async () => {
    const insert = (type: string, ceiling: number | null, start: string, end: string) =>
      database.pool.query(
        `INSERT INTO auctions (store_id, card_id, type, start_time, end_time, initial_bid, min_increment, max_poll_value)
         VALUES ($1, $2, $3, $4, $5, 10, 1, $6)`,
        [SEED_IDS.storeA, cardA(20), type, start, end, ceiling],
      );

    await expect(insert('POLL', null, '2098-01-01', '2098-01-02')).rejects.toMatchObject({
      constraint: 'auctions_poll_ceiling',
    });
    await expect(insert('FREE_BID', 50, '2098-01-01', '2098-01-02')).rejects.toMatchObject({
      constraint: 'auctions_poll_ceiling',
    });
    await expect(insert('FREE_BID', null, '2098-01-02', '2098-01-01')).rejects.toMatchObject({
      constraint: 'auctions_period_valid',
    });
  });

  it('recusa dois lances do mesmo valor no mesmo leilão (o primeiro vence o empate)', async () => {
    await expectRejected(
      `INSERT INTO bids (store_id, auction_id, customer_id, amount, raw_whatsapp_message)
       VALUES ($1, $2, $3, 20, '#A2 20')`,
      [SEED_IDS.storeA, uid(KIND.auction, 2), uid(KIND.customer, 8)],
      'bids_auction_amount_key',
    );
  });

  it('recusa lance de cliente de outra loja', async () => {
    await expectRejected(
      `INSERT INTO bids (store_id, auction_id, customer_id, amount, raw_whatsapp_message)
       VALUES ($1, $2, $3, 500, '#A2 500')`,
      [SEED_IDS.storeA, uid(KIND.auction, 2), uid(KIND.customer, 101)],
      'bids_customer_fkey',
    );
  });

  it('recusa lance vencedor de outro leilão da loja errada', async () => {
    await expectRejected(
      'UPDATE auctions SET winning_bid_id = $1 WHERE id = $2',
      [uid(KIND.bid, 1100), uid(KIND.auction, 2)],
      'auctions_winning_bid_fkey',
    );
  });

  it('recusa acerto pago sem data de pagamento e pendente com data', async () => {
    const insert = (status: string, paidAt: string | null) =>
      database.pool.query(
        `INSERT INTO settlements (store_id, customer_id, total_amount, status, paid_at)
         VALUES ($1, $2, 10, $3, $4)`,
        [SEED_IDS.storeA, uid(KIND.customer, 1), status, paidAt],
      );

    await expect(insert('PAID', null)).rejects.toMatchObject({
      constraint: 'settlements_paid_at_matches_status',
    });
    await expect(insert('PENDING', '2026-10-01')).rejects.toMatchObject({
      constraint: 'settlements_paid_at_matches_status',
    });
  });

  it('recusa colocar o mesmo leilão em dois acertos', async () => {
    await expectRejected(
      `INSERT INTO settlement_items (store_id, settlement_id, auction_id, card_id, amount)
       VALUES ($1, $2, $3, $4, 20)`,
      [SEED_IDS.storeA, uid(KIND.settlement, 2), uid(KIND.auction, 5), cardA(6)],
      'settlement_items_auction_key',
    );
  });

  it('recusa limite de lojas sem a permissão de criar lojas', async () => {
    await expect(
      database.pool.query(
        "INSERT INTO users (email, store_limit) VALUES ('limite@example.com', 2)",
      ),
    ).rejects.toMatchObject({ constraint: 'users_store_limit_requires_permission' });
  });

  it('recusa convite com loja sem papel e convite aceito sem data', async () => {
    const insert = (
      storeId: string | null,
      role: string | null,
      status: string,
      acceptedAt: string | null,
    ) =>
      database.pool.query(
        `INSERT INTO invitations (token_hash, email, store_id, role, status, accepted_at, expires_at)
         VALUES (gen_random_uuid()::text, 'x@example.com', $1, $2, $3, $4, '2099-01-01')`,
        [storeId, role, status, acceptedAt],
      );

    await expect(insert(SEED_IDS.storeA, null, 'PENDING', null)).rejects.toMatchObject({
      constraint: 'invitations_store_requires_role',
    });
    await expect(insert(null, null, 'ACCEPTED', null)).rejects.toMatchObject({
      constraint: 'invitations_accepted_at_matches_status',
    });
  });

  it('recusa email de usuário fora de minúsculas e OTP com tentativas negativas', async () => {
    await expect(
      database.pool.query("INSERT INTO users (email) VALUES ('Maiusculo@Example.com')"),
    ).rejects.toMatchObject({ constraint: 'users_email_lowercase' });
    await expect(
      database.pool.query("INSERT INTO users (email, otp_attempts) VALUES ('x@example.com', -1)"),
    ).rejects.toMatchObject({ constraint: 'users_otp_attempts_nonneg' });
  });

  it('apagar a loja leva junto todos os dados dela e preserva as outras', async () => {
    await database.pool.query('DELETE FROM stores WHERE id = $1', [SEED_IDS.storeC]);

    expect(await count('customers', `store_id = '${SEED_IDS.storeC}'`)).toBe(0);
    expect(await count('cards_inventory', `store_id = '${SEED_IDS.storeC}'`)).toBe(0);
    expect(await count('cards_inventory', `store_id = '${SEED_IDS.storeA}'`)).toBeGreaterThan(0);
  });
});
