import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDb } from '../src/db/context.js';
import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { purgeExpired } from '../src/jobs/maintenance.js';
import { startWorld, type World } from './helpers/world.js';

/** Limpeza de dados vencidos (`purge_expired`): só o técnico e efêmero. Postgres real, papel `app_api`. */

let world: World;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await world.stop();
});

beforeEach(async () => {
  await world.reseed();
});

const ago = (days: number): string => `now() - interval '${String(days)} days'`;
const count = async (sql: string): Promise<number> =>
  Number((await world.admin.query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`)).rows[0]?.n);

const HASH = (n: number): string => n.toString(16).padStart(64, '0');

async function insertToken(n: number, expires: string, revoked: string | null): Promise<void> {
  await world.admin.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, revoked_at)
     VALUES ($1, $2, ${expires}, ${revoked ?? 'NULL'})`,
    [SEED_IDS.userOwner, `limpeza-${String(n)}`],
  );
}

describe('purge_expired', () => {
  it('apaga sessões vencidas ou revogadas há mais de 30 dias e guarda as demais', async () => {
    await world.admin.query('DELETE FROM refresh_tokens');
    await insertToken(1, ago(40), null);
    await insertToken(2, `now() + interval '5 days'`, ago(40));
    await insertToken(3, ago(10), null);
    await insertToken(4, `now() + interval '5 days'`, ago(1));
    await insertToken(5, `now() + interval '5 days'`, null);

    const summary = await purgeExpired(createDb(world.appPool));

    expect(summary.sessions).toBe(2);
    const left = await world.admin.query<{ token_hash: string }>(
      'SELECT token_hash FROM refresh_tokens ORDER BY token_hash',
    );
    expect(left.rows.map((r) => r.token_hash)).toEqual(['limpeza-3', 'limpeza-4', 'limpeza-5']);
  });

  it('limpa códigos de login vencidos há mais de um dia, sem tocar nos que ainda valem', async () => {
    await world.admin.query(
      `UPDATE users SET otp_hash = 'h', otp_expires_at = ${ago(2)}, otp_attempts = 3 WHERE id = $1`,
      [SEED_IDS.userStaff],
    );
    await world.admin.query(
      `UPDATE users SET otp_hash = 'h', otp_expires_at = now() + interval '5 minutes' WHERE id = $1`,
      [SEED_IDS.userOwner],
    );

    const summary = await purgeExpired(createDb(world.appPool));

    expect(summary.otps_cleared).toBeGreaterThanOrEqual(1);
    const rows = await world.admin.query<{
      id: string;
      otp_hash: string | null;
      otp_attempts: number;
    }>('SELECT id, otp_hash, otp_attempts FROM users WHERE id = ANY($1::uuid[])', [
      [SEED_IDS.userStaff, SEED_IDS.userOwner],
    ]);
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get(SEED_IDS.userStaff)).toMatchObject({ otp_hash: null, otp_attempts: 0 });
    expect(byId.get(SEED_IDS.userOwner)?.otp_hash).toBe('h');
  });

  it('apaga falhas antigas por IP, mas não a que ainda bloqueia nem a recente', async () => {
    await world.admin.query(
      `INSERT INTO public_ip_failures (ip_hash, failures, window_started_at, locked_until) VALUES
        ($1, 3, ${ago(3)}, NULL),
        ($2, 20, ${ago(3)}, now() + interval '10 minutes'),
        ($3, 1, now(), NULL)`,
      [HASH(1), HASH(2), HASH(3)],
    );

    const summary = await purgeExpired(createDb(world.appPool));

    expect(summary.ip_failures).toBe(1);
    const left = await world.admin.query<{ ip_hash: string }>(
      'SELECT ip_hash FROM public_ip_failures ORDER BY ip_hash',
    );
    expect(left.rows.map((r) => r.ip_hash)).toEqual([HASH(2), HASH(3)]);
  });

  it('apaga links públicos vencidos ou revogados há mais de 90 dias, e só eles', async () => {
    const link = (n: number, expires: string, revoked: string | null) =>
      world.admin.query(
        `INSERT INTO public_links (store_id, kind, customer_id, token_hash, expires_at, revoked_at)
         VALUES ($1, 'CONSIGNOR', $2, $3, ${expires}, ${revoked ?? 'NULL'})`,
        [SEED_IDS.storeA, uid(KIND.customer, 1), HASH(100 + n)],
      );
    await link(1, ago(100), null);
    await link(2, `now() + interval '5 days'`, ago(100));
    await link(3, ago(5), null);
    await link(4, `now() + interval '5 days'`, ago(5));
    const before = await count('public_links');

    const summary = await purgeExpired(createDb(world.appPool));

    expect(summary.public_links).toBe(2);
    expect(await count('public_links')).toBe(before - 2);
  });

  it('apaga convites revogados ou pendentes e vencidos há mais de 90 dias; os aceitos ficam', async () => {
    await world.admin.query('DELETE FROM invitations');
    const invite = (email: string, status: string, created: string, expires: string) =>
      world.admin.query(
        `INSERT INTO invitations (token_hash, email, status, expires_at, created_at, accepted_at)
         VALUES ($1, $2, $3, ${expires}, ${created}, ${status === 'ACCEPTED' ? 'now()' : 'NULL'})`,
        [`conv-${email}`, email, status],
      );
    await invite('revogado-antigo@example.com', 'REVOKED', ago(100), ago(90));
    await invite('vencido-antigo@example.com', 'PENDING', ago(120), ago(100));
    await invite('aceito-antigo@example.com', 'ACCEPTED', ago(200), ago(190));
    await invite('revogado-recente@example.com', 'REVOKED', ago(5), `now() + interval '2 days'`);
    await invite('pendente@example.com', 'PENDING', ago(1), `now() + interval '6 days'`);

    const summary = await purgeExpired(createDb(world.appPool));

    expect(summary.invitations).toBe(2);
    const left = await world.admin.query<{ email: string }>(
      'SELECT email FROM invitations ORDER BY email',
    );
    expect(left.rows.map((r) => r.email)).toEqual([
      'aceito-antigo@example.com',
      'pendente@example.com',
      'revogado-recente@example.com',
    ]);
  });

  it('apaga execuções do sync com mais de 180 dias', async () => {
    await world.admin.query('DELETE FROM catalog_sync_runs');
    await world.admin.query(
      `INSERT INTO catalog_sync_runs (source, languages, status, started_at, finished_at) VALUES
        ('tcgdex', '{en}', 'OK', ${ago(200)}, ${ago(200)}), ('tcgdex', '{en}', 'OK', ${ago(10)}, ${ago(10)})`,
    );

    const summary = await purgeExpired(createDb(world.appPool));

    expect(summary.catalog_runs).toBe(1);
    expect(await count('catalog_sync_runs')).toBe(1);
  });

  it('NÃO toca em dado pessoal nem em registro imutável (pedidos de acesso, avisos, log, clientes)', async () => {
    await world.admin.query(`UPDATE access_requests SET created_at = ${ago(400)}`);
    await world.admin.query(`UPDATE notifications SET created_at = ${ago(400)}`);
    const before = {
      requests: await count('access_requests'),
      notifications: await count('notifications'),
      log: await count('activity_log'),
      customers: await count('customers'),
      settlements: await count('settlements'),
    };

    await purgeExpired(createDb(world.appPool));

    expect({
      requests: await count('access_requests'),
      notifications: await count('notifications'),
      log: await count('activity_log'),
      customers: await count('customers'),
      settlements: await count('settlements'),
    }).toEqual(before);
  });

  it('é idempotente: a segunda rodada não apaga mais nada', async () => {
    await insertToken(9, ago(60), null);
    const first = await purgeExpired(createDb(world.appPool));
    expect(first.sessions).toBeGreaterThanOrEqual(1);

    const second = await purgeExpired(createDb(world.appPool));

    expect(second).toEqual({
      sessions: 0,
      otps_cleared: 0,
      ip_failures: 0,
      public_links: 0,
      invitations: 0,
      catalog_runs: 0,
      whatsapp_pairing: 0,
    });
  });

  it('só o papel da API executa; o papel público e a leitura direta continuam negados', async () => {
    await expect(world.appPool.query('SELECT purge_expired()')).resolves.toBeDefined();
    await expect(world.appPool.query('DELETE FROM public_ip_failures')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(world.appPool.query('DELETE FROM invitations')).rejects.toMatchObject({
      code: '42501',
    });

    const client = await world.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE public_runtime');
      await expect(client.query('SELECT purge_expired()')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
