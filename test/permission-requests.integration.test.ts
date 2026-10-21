import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SEED_IDS } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/** POST /v1/store/permission-requests: o funcionário pede uma permissão ao proprietário. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const OTHER_OWNER = 'outro-dono@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const URL = '/v1/store/permission-requests';

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await world.stop();
});

beforeEach(async () => {
  await world.reseed();
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
  method: 'GET' | 'POST',
  url: string,
  session: Session,
  storeId: string | undefined,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: session.headers(storeId),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const ask = (
  server: TestApp,
  session: Session,
  permission: unknown,
  storeId: string | undefined = A,
) => call(server, 'POST', URL, session, storeId, { permission });

interface Notice {
  kind: string;
  data: Record<string, unknown>;
}

const notices = async (server: TestApp, session: Session, storeId: string) =>
  (await call(server, 'GET', '/v1/notifications?limit=100', session, storeId)).json<{
    items: Notice[];
  }>().items;

describe('pedido de permissão', () => {
  it('avisa o proprietário e registra no log, sem conceder nada', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);

    const response = await ask(server, staff, 'can_view_finance');

    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ permission: 'can_view_finance' });
    expect(Date.parse(response.json<{ requested_at: string }>().requested_at)).not.toBeNaN();

    const found = (await notices(server, owner, A))
      .filter((n) => n.kind === 'PERMISSION_REQUESTED')
      .map(({ kind, data }) => ({ kind, data }));
    expect(found).toEqual([
      {
        kind: 'PERMISSION_REQUESTED',
        data: { user_id: SEED_IDS.userStaff, permission: 'can_view_finance' },
      },
    ]);
    expect(JSON.stringify(found)).not.toContain('@');

    const log = await call(server, 'GET', '/v1/activity-log?limit=100', owner, A);
    const entries = log
      .json<{ items: { action: string; actor_user_id: string; details: unknown }[] }>()
      .items.filter((e) => e.action === 'permission.requested');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      action: 'permission.requested',
      actor_user_id: SEED_IDS.userStaff,
      details: { permission: 'can_view_finance' },
    });

    // não concede: o financeiro continua barrado para o funcionário
    const finance = await call(server, 'GET', '/v1/finance/overview', staff, A);
    expect(finance.statusCode).toBe(403);
    const me = await call(server, 'GET', '/v1/store', staff, A);
    expect(
      me.json<{ permissions: Record<string, boolean> }>().permissions['can_view_finance'],
    ).toBe(false);
  });

  it('o mesmo pedido da mesma pessoa só se repete depois de 24 horas', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);

    expect((await ask(server, staff, 'can_delete')).statusCode).toBe(201);
    const again = await ask(server, staff, 'can_delete');
    expect(again.statusCode).toBe(429);
    expect(again.json()).toMatchObject({ code: 'PERMISSION_REQUEST_TOO_SOON' });
    // outra permissão é outro pedido
    expect((await ask(server, staff, 'can_view_finance')).statusCode).toBe(201);

    const pending = (await notices(server, owner, A)).filter(
      (n) => n.kind === 'PERMISSION_REQUESTED',
    );
    expect(pending).toHaveLength(2);

    await world.admin.query(
      "UPDATE notifications SET created_at = now() - interval '25 hours' WHERE kind = 'PERMISSION_REQUESTED'",
    );
    expect((await ask(server, staff, 'can_delete')).statusCode).toBe(201);
  });

  it('pedidos simultâneos: só um passa', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => ask(server, staff, 'can_delete')),
    );

    expect(results.map((r) => r.statusCode).toSorted((a, b) => a - b)).toEqual([
      201, 429, 429, 429,
    ]);
    const count = await world.admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM notifications WHERE kind = 'PERMISSION_REQUESTED'",
    );
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('quem já tem a permissão recebe 409, inclusive o proprietário', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);

    // o funcionário já pode gerir leilões
    const has = await ask(server, staff, 'can_manage_auctions');
    expect(has.statusCode).toBe(409);
    expect(has.json()).toMatchObject({ code: 'PERMISSION_ALREADY_GRANTED' });
    expect((await ask(server, owner, 'can_delete')).statusCode).toBe(409);
    expect(
      await world.admin.query("SELECT 1 FROM notifications WHERE kind = 'PERMISSION_REQUESTED'"),
    ).toMatchObject({
      rowCount: 0,
    });
  });

  it('valida a permissão e exige login e participação na loja', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    for (const permission of ['can_fly', '', 42, null]) {
      expect((await ask(server, staff, permission)).statusCode, String(permission)).toBe(400);
    }
    const extra = await call(server, 'POST', URL, staff, A, {
      permission: 'can_delete',
      user_id: SEED_IDS.userOwner,
    });
    expect(extra.statusCode).toBe(201);

    const anonymous = await server.app.inject({
      method: 'POST',
      url: URL,
      headers: { 'x-store-id': A },
      payload: { permission: 'can_delete' },
    });
    expect(anonymous.statusCode).toBe(401);
    const noStore = await call(server, 'POST', URL, staff, undefined, { permission: 'can_delete' });
    expect(noStore.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('acesso cruzado: não pede em loja de que não participa e não aparece em outra loja', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);
    const otherOwner = await login(server, OTHER_OWNER);

    // o funcionário só participa da loja A
    expect((await ask(server, staff, 'can_delete', B)).statusCode).toBe(403);
    expect(await ask(server, staff, 'can_delete')).toMatchObject({ statusCode: 201 });

    // o aviso é só da loja A, mesmo para quem é proprietário também da B
    expect((await notices(server, owner, B)).some((n) => n.kind === 'PERMISSION_REQUESTED')).toBe(
      false,
    );
    expect(
      (await notices(server, otherOwner, SEED_IDS.storeC)).some(
        (n) => n.kind === 'PERMISSION_REQUESTED',
      ),
    ).toBe(false);
    const row = await world.admin.query<{ store_id: string }>(
      "SELECT store_id FROM notifications WHERE kind = 'PERMISSION_REQUESTED'",
    );
    expect(row.rows.map((r) => r.store_id)).toEqual([A]);
  });
});
