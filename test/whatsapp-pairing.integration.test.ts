import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SEED_IDS } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/** Pareamento do WhatsApp pelo painel (shared#36, migration 0028). Postgres real, papel app_api. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const OTHER_OWNER = 'outro-dono@example.com';
const STAFF = 'funcionario@example.com';
const ADMIN = 'admin@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const C = SEED_IDS.storeC;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await world.stop();
});

beforeEach(async () => {
  await world.reseed();
  // Ponto de partida igual em todo teste: a loja A desconectada e sem sessão pareada.
  await world.admin.query(
    "UPDATE stores SET whatsapp_status = 'OFFLINE', whatsapp_group_id = NULL WHERE id = $1",
    [A],
  );
  await world.admin.query('DELETE FROM whatsapp_sessions WHERE store_id = $1', [A]);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(): Promise<TestApp> {
  app = await buildTestApp({ pool: world.appPool });
  return app;
}

const call = (
  server: TestApp,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  session: Session,
  storeId: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: session.headers(storeId),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

interface StatusJson {
  state: string;
  requested_at: string | null;
  qr: { code: string; expires_at: string } | null;
  group_id: string | null;
}

const status = async (server: TestApp, session: Session, storeId = A) => {
  const response = await call(server, 'GET', '/v1/store/whatsapp', session, storeId);
  expect(response.statusCode, response.body).toBe(200);
  return response.json<StatusJson>();
};

/** O que o bot faz: publica o QR e os grupos na linha da loja. */
const botPublishes = (store: string, qrSeconds: number) =>
  world.admin.query(
    `INSERT INTO whatsapp_pairing (store_id, qr_code, qr_expires_at, groups, groups_updated_at)
     VALUES ($1, 'qr-secreto-do-bot', now() + make_interval(secs => $2),
             '[{"id":"120363111111111111@g.us","name":"Leilão Pokémon"}]'::jsonb, now())
     ON CONFLICT (store_id) DO UPDATE
       SET qr_code = EXCLUDED.qr_code, qr_expires_at = EXCLUDED.qr_expires_at,
           groups = EXCLUDED.groups, groups_updated_at = EXCLUDED.groups_updated_at`,
    [store, qrSeconds],
  );

describe('pedido e estado (POST/GET /v1/store/whatsapp)', () => {
  it('loja nova: IDLE; pedir marca REQUESTED, registra no log e repetir não renova', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    expect((await status(server, owner)).state).toBe('IDLE');

    const first = await call(server, 'POST', '/v1/store/whatsapp/pair', owner, A);
    expect(first.statusCode, first.body).toBe(202);
    expect(first.headers['cache-control']).toBe('no-store');
    const requested = first.json<StatusJson>();
    expect(requested).toMatchObject({ state: 'REQUESTED', qr: null });
    expect(requested.requested_at).not.toBeNull();

    const again = await call(server, 'POST', '/v1/store/whatsapp/pair', owner, A);
    expect(again.statusCode).toBe(202);
    expect(again.json<StatusJson>().requested_at).toBe(requested.requested_at);

    await world.admin.query(
      "UPDATE whatsapp_pairing SET requested_at = now() - interval '31 seconds' WHERE store_id = $1",
      [A],
    );
    const renewed = await call(server, 'POST', '/v1/store/whatsapp/pair', owner, A);
    expect(renewed.json<StatusJson>().requested_at).not.toBe(requested.requested_at);

    const log = await world.admin.query<{ n: string; details: object }>(
      `SELECT count(*) AS n, min(details::text) AS details FROM activity_log
        WHERE action = 'whatsapp.pair_requested' AND store_id = $1`,
      [A],
    );
    expect(Number(log.rows[0]?.n)).toBe(2);
    expect(log.rows[0]?.details).toBe('{}');
  });

  it('o QR do bot aparece enquanto vale, some ao vencer e nunca vai a loja ONLINE', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await call(server, 'POST', '/v1/store/whatsapp/pair', owner, A);

    await botPublishes(A, 60);
    const ready = await status(server, owner);
    expect(ready).toMatchObject({ state: 'QR_READY', qr: { code: 'qr-secreto-do-bot' } });
    expect(Date.parse(ready.qr?.expires_at ?? '')).toBeGreaterThan(Date.now());

    await botPublishes(A, -1);
    const expired = await status(server, owner);
    expect(expired.qr).toBeNull();
    expect(expired.state).toBe('REQUESTED');

    await botPublishes(A, 60);
    await world.admin.query("UPDATE stores SET whatsapp_status = 'ONLINE' WHERE id = $1", [A]);
    const online = await status(server, owner);
    expect(online).toMatchObject({ state: 'ONLINE', qr: null });
  });

  it('já conectada: 409; caída depois de parear: OFFLINE; pedido esquecido deixa de contar', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    await world.admin.query("UPDATE stores SET whatsapp_status = 'ONLINE' WHERE id = $1", [A]);
    const refused = await call(server, 'POST', '/v1/store/whatsapp/pair', owner, A);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'WHATSAPP_ALREADY_CONNECTED' });

    await world.admin.query("UPDATE stores SET whatsapp_status = 'OFFLINE' WHERE id = $1", [A]);
    await world.admin.query(
      "INSERT INTO whatsapp_sessions (store_id, session_data) VALUES ($1, 'cifrado')",
      [A],
    );
    expect((await status(server, owner)).state).toBe('OFFLINE');

    await call(server, 'POST', '/v1/store/whatsapp/pair', owner, A);
    await world.admin.query(
      "UPDATE whatsapp_pairing SET requested_at = now() - interval '11 minutes' WHERE store_id = $1",
      [A],
    );
    expect(await status(server, owner)).toMatchObject({ state: 'OFFLINE', requested_at: null });
  });
});

describe('só o proprietário, só a própria loja', () => {
  it('funcionário, administrador e visitante recebem 403/401 em toda rota, e o QR não vaza', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const admin = await login(server, ADMIN);
    await botPublishes(A, 60);

    for (const who of [staff, admin]) {
      for (const [method, url] of [
        ['GET', '/v1/store/whatsapp'],
        ['POST', '/v1/store/whatsapp/pair'],
        ['GET', '/v1/store/whatsapp/groups'],
      ] as const) {
        const response = await call(server, method, url, who, A);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(response.body).not.toContain('qr-secreto-do-bot');
      }
    }
    expect((await server.app.inject({ method: 'GET', url: '/v1/store/whatsapp' })).statusCode).toBe(
      401,
    );
  });

  it('o banco também barra: funcionário e administrador não leem a linha, o dono da loja B tampouco', async () => {
    await botPublishes(A, 60);
    const readAs = async (context: Record<string, string>) => {
      const client = await world.appPool.connect();
      try {
        await client.query('BEGIN');
        for (const [key, value] of Object.entries(context)) {
          await client.query('SELECT set_config($1, $2, true)', [key, value]);
        }
        const rows = await client.query('SELECT store_id FROM whatsapp_pairing');
        await client.query('ROLLBACK');
        return rows.rowCount;
      } finally {
        client.release();
      }
    };
    expect(await readAs({ 'app.store_id': A, 'app.user_id': SEED_IDS.userOwner })).toBe(1);
    expect(await readAs({ 'app.store_id': A, 'app.user_id': SEED_IDS.userStaff })).toBe(0);
    expect(await readAs({ 'app.store_id': A, 'app.user_id': SEED_IDS.userAdmin })).toBe(0);
    expect(
      await readAs({ 'app.is_platform_admin': 'true', 'app.user_id': SEED_IDS.userAdmin }),
    ).toBe(0);
    expect(await readAs({ 'app.user_id': SEED_IDS.userOwner })).toBe(0);
    expect(await readAs({ 'app.store_id': B, 'app.user_id': SEED_IDS.userOtherOwner })).toBe(0);
  });

  it('acesso cruzado: quem é dono de duas lojas só vê a do cabeçalho, e o de outra loja nada', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const other = await login(server, OTHER_OWNER);
    await botPublishes(A, 60);

    expect((await status(server, owner, A)).qr?.code).toBe('qr-secreto-do-bot');
    expect(await status(server, owner, B)).toMatchObject({
      state: expect.any(String) as string,
      qr: null,
    });
    // o proprietário da loja C não participa da A: 403 com o cabeçalho trocado
    const foreign = await call(server, 'GET', '/v1/store/whatsapp', other, A);
    expect(foreign.statusCode).toBe(403);
    expect(foreign.body).not.toContain('qr-secreto-do-bot');
    expect((await status(server, other, C)).qr).toBeNull();
    // o pedido de A não cria linha em B
    await call(server, 'POST', '/v1/store/whatsapp/pair', owner, A);
    const rows = await world.admin.query<{ store_id: string }>(
      'SELECT store_id FROM whatsapp_pairing WHERE requested_at IS NOT NULL',
    );
    expect(rows.rows.map((r) => r.store_id)).toEqual([A]);
  });
});

describe('grupos e escolha do grupo', () => {
  it('lista o que o bot publicou e só aceita no PATCH /v1/store um grupo dessa lista', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    expect((await call(server, 'GET', '/v1/store/whatsapp/groups', owner, A)).json()).toEqual({
      items: [],
      updated_at: null,
    });

    await botPublishes(A, 60);
    const groups = await call(server, 'GET', '/v1/store/whatsapp/groups', owner, A);
    expect(groups.json<{ items: unknown[] }>().items).toEqual([
      { id: '120363111111111111@g.us', name: 'Leilão Pokémon' },
    ]);

    const unknown = await call(server, 'PATCH', '/v1/store', owner, A, {
      whatsapp_group_id: '999999@g.us',
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ code: 'WHATSAPP_GROUP_UNKNOWN' });

    const chosen = await call(server, 'PATCH', '/v1/store', owner, A, {
      whatsapp_group_id: '120363111111111111@g.us',
    });
    expect(chosen.statusCode, chosen.body).toBe(200);
    expect((await status(server, owner)).group_id).toBe('120363111111111111@g.us');

    const cleared = await call(server, 'PATCH', '/v1/store', owner, A, { whatsapp_group_id: null });
    expect(cleared.statusCode).toBe(200);
    expect((await status(server, owner)).group_id).toBeNull();

    // a lista de A não vale para B
    const crossed = await call(server, 'PATCH', '/v1/store', owner, B, {
      whatsapp_group_id: '120363111111111111@g.us',
    });
    expect(crossed.statusCode).toBe(422);
  });

  it('funcionário não escolhe grupo', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    await botPublishes(A, 60);
    const response = await call(server, 'PATCH', '/v1/store', staff, A, {
      whatsapp_group_id: '120363111111111111@g.us',
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('limpeza (purge_expired)', () => {
  it('apaga o QR vencido e o pedido esquecido, e deixa o que ainda vale', async () => {
    await world.admin.query(
      `INSERT INTO whatsapp_pairing (store_id, requested_at, qr_code, qr_expires_at) VALUES
         ($1, now() - interval '11 minutes', 'qr-velho', now() - interval '5 minutes'),
         ($2, now(), 'qr-novo', now() + interval '60 seconds')`,
      [A, B],
    );

    const result = await world.appPool.query<{ summary: { whatsapp_pairing: number } }>(
      'SELECT purge_expired() AS summary',
    );

    expect(result.rows[0]?.summary.whatsapp_pairing).toBe(1);
    const rows = await world.admin.query<{
      store_id: string;
      qr_code: string | null;
      requested_at: Date | null;
    }>('SELECT store_id, qr_code, requested_at FROM whatsapp_pairing ORDER BY store_id');
    const byStore = new Map(rows.rows.map((r) => [r.store_id, r]));
    expect(byStore.get(A)).toMatchObject({ qr_code: null, requested_at: null });
    expect(byStore.get(B)?.qr_code).toBe('qr-novo');
    expect(byStore.get(B)?.requested_at).not.toBeNull();
  });
});
