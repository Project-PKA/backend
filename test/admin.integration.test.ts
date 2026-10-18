import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/**
 * Sprint 02: administração da plataforma (/v1/admin), pedidos de acesso e a fronteira do administrador.
 * Postgres real, papel `app_api` (RLS valendo).
 */

let world: World;
let app: TestApp | undefined;

const ADMIN = 'admin@example.com';
const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const C = SEED_IDS.storeC;
const PENDING_REQUEST = uid(KIND.request, 1);

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

async function start(env: NodeJS.ProcessEnv = {}): Promise<TestApp> {
  app = await buildTestApp({ pool: world.appPool, env });
  return app;
}

const call = (
  server: TestApp,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  session: Session,
  payload?: unknown,
  storeId?: string,
) =>
  server.app.inject({
    method,
    url,
    headers: session.headers(storeId),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const tokenFrom = (link: string | undefined): string => link?.split('#token=')[1] ?? '';
const acceptInvitation = (server: TestApp, token: string) =>
  server.app.inject({ method: 'POST', url: '/v1/auth/invitations/accept', payload: { token } });

interface UserJson {
  id: string;
  email: string;
  status: string;
  can_create_stores: boolean;
  store_limit: number;
  stores_count: number;
  last_login_at: string | null;
  stores?: { id: string; name: string; role: string }[];
}

interface StoreJson {
  id: string;
  name: string;
  city: string | null;
  plan: string;
  member_limit: number;
  members_count: number;
  owner: { id: string; email: string } | null;
  whatsapp_status: string;
}

describe('fronteira: só o administrador da plataforma', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/v1/admin/users'],
    ['GET', `/v1/admin/users/${SEED_IDS.userStaff}`],
    ['POST', '/v1/admin/users', { email: 'x@example.com' }],
    ['PATCH', `/v1/admin/users/${SEED_IDS.userStaff}/permissions`, { can_create_stores: true }],
    ['POST', `/v1/admin/users/${SEED_IDS.userStaff}/suspend`],
    ['POST', `/v1/admin/users/${SEED_IDS.userStaff}/reactivate`],
    ['GET', '/v1/admin/stores'],
    ['POST', '/v1/admin/stores', { name: 'X', owner_email: 'x@example.com' }],
    ['POST', `/v1/admin/stores/${A}/transfer-ownership`, { new_owner_user_id: SEED_IDS.userStaff }],
    ['GET', '/v1/admin/invitations'],
    ['GET', '/v1/admin/access-requests'],
    ['POST', `/v1/admin/access-requests/${PENDING_REQUEST}/refuse`],
    ['GET', '/v1/admin/dashboard'],
    ['GET', '/v1/admin/activity-log'],
  ];

  it('sem login é 401 e proprietário ou funcionário (mesmo de loja) é 403, em toda rota', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    for (const [method, url, payload] of routes) {
      const anonymous = await server.app.inject({
        method: method as 'GET',
        url,
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
      expect(anonymous.statusCode, `${method} ${url}`).toBe(401);
      for (const session of [owner, staff]) {
        const response = await call(server, method as 'GET', url, session, payload, A);
        expect(response.statusCode, `${method} ${url}`).toBe(403);
      }
    }
  });

  it('o administrador não precisa de x-store-id e não lê dado interno de loja', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    expect((await call(server, 'GET', '/v1/admin/users', admin)).statusCode).toBe(200);
    for (const url of ['/v1/cards', '/v1/customers', '/v1/auctions', '/v1/settlements']) {
      const response = await call(server, 'GET', url, admin, undefined, A);
      expect(response.statusCode, url).toBe(403);
    }
    const noStore = await call(server, 'GET', '/v1/cards', admin);
    expect(noStore.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('as respostas do painel não trazem estoque, clientes, lances nem acertos', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const bodies = await Promise.all(
      [
        `/v1/admin/users/${SEED_IDS.userOwner}`,
        '/v1/admin/stores',
        '/v1/admin/dashboard',
        '/v1/admin/invitations',
      ].map(async (url) => (await call(server, 'GET', url, admin)).body),
    );
    const secrets = await world.admin.query<{ phone: string; short_code: string }>(
      `SELECT cu.phone, c.short_code FROM customers cu, cards_inventory c WHERE cu.store_id = $1 AND c.store_id = $1 LIMIT 1`,
      [A],
    );
    for (const body of bodies) {
      expect(body).not.toContain(secrets.rows[0]?.phone ?? 'x');
      expect(body).not.toMatch(/short_code|raw_whatsapp|cards_inventory|bids/);
    }
  });
});

describe('usuários', () => {
  it('lista com busca, filtros e cursor, com a quantidade de lojas', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const list = async (query = '') =>
      (await call(server, 'GET', `/v1/admin/users?limit=100${query}`, admin)).json<{
        items: UserJson[];
      }>().items;

    const all = await list();
    expect(all).toHaveLength(7);
    expect(all.find((u) => u.email === OWNER)?.stores_count).toBe(2);
    expect((await list('&status=SUSPENDED')).map((u) => u.email)).toEqual(['suspenso@example.com']);
    expect((await list('&q=FUNCION')).map((u) => u.email)).toEqual([STAFF]);
    expect(await list('&q=%25')).toHaveLength(0);
    const creators = await list('&can_create_stores=true');
    expect(creators.length).toBeGreaterThan(0);
    expect(creators.every((u) => u.can_create_stores)).toBe(true);

    const first = (await call(server, 'GET', '/v1/admin/users?limit=3', admin)).json<{
      items: UserJson[];
      next_cursor: string | null;
    }>();
    const second = (
      await call(server, 'GET', `/v1/admin/users?limit=10&cursor=${first.next_cursor}`, admin)
    ).json<{ items: UserJson[] }>();
    expect(new Set([...first.items, ...second.items].map((u) => u.id)).size).toBe(7);
    expect((await call(server, 'GET', '/v1/admin/users?cursor=lixo', admin)).statusCode).toBe(400);
  });

  it('o detalhe mostra as lojas (nome e papel) e nada além', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    const response = await call(server, 'GET', `/v1/admin/users/${SEED_IDS.userOwner}`, admin);

    expect(response.statusCode).toBe(200);
    const user = response.json<UserJson>();
    expect(
      user.stores?.map((s) => [s.name, s.role]).sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual([
      ['Cartas do Zé 🔥', 'OWNER'],
      ['Pokémon Açaí', 'OWNER'],
    ]);
    expect(response.body).not.toMatch(/otp|token|hash/i);
    expect(
      (await call(server, 'GET', `/v1/admin/users/${uid(KIND.user, 999)}`, admin)).statusCode,
    ).toBe(404);
  });

  it('cadastra a conta, envia o convite de conta e registra no log da plataforma', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    const created = await call(server, 'POST', '/v1/admin/users', admin, {
      email: 'Novo.Lojista@Example.com',
      name: 'Novo Lojista',
      can_create_stores: true,
      store_limit: 2,
    });
    await server.invitations.flush();

    expect(created.statusCode, created.body).toBe(201);
    expect(created.json<UserJson>()).toMatchObject({
      email: 'novo.lojista@example.com',
      status: 'INVITED',
      can_create_stores: true,
      store_limit: 2,
    });
    const token = tokenFrom(server.email.lastInvitationFor('novo.lojista@example.com')?.link);
    expect(token.length).toBeGreaterThan(20);
    expect((await acceptInvitation(server, token)).statusCode).toBe(200);
    const active = await world.admin.query<{ status: string }>(
      "SELECT status FROM users WHERE email = 'novo.lojista@example.com'",
    );
    expect(active.rows[0]?.status).toBe('ACTIVE');

    const log = await call(server, 'GET', '/v1/admin/activity-log?limit=5', admin);
    const entry = log.json<{ items: { action: string; details: object }[] }>().items[0];
    expect(entry?.action).toBe('user.created');
    expect(JSON.stringify(entry?.details)).not.toContain('novo.lojista');
  });

  it('recusa e-mail repetido e limite incoerente ou negativo', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const post = (payload: unknown) => call(server, 'POST', '/v1/admin/users', admin, payload);

    expect((await post({ email: OWNER })).json()).toMatchObject({ code: 'ADMIN_EMAIL_TAKEN' });
    expect((await post({ email: 'a@example.com', store_limit: 3 })).json()).toMatchObject({
      code: 'ADMIN_INVALID_LIMIT',
    });
    expect((await post({ email: 'a@example.com', store_limit: -1 })).statusCode).toBe(400);
    expect((await post({ email: 'nao-e-email' })).statusCode).toBe(400);
    expect((await post({ email: 'a@example.com', is_platform_admin: true })).statusCode).toBe(201);
    const flag = await world.admin.query<{ is_platform_admin: boolean }>(
      "SELECT is_platform_admin FROM users WHERE email = 'a@example.com'",
    );
    expect(flag.rows[0]?.is_platform_admin).toBe(false);
  });

  it('altera as permissões globais respeitando a regra do banco', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const patch = (id: string, payload: unknown) =>
      call(server, 'PATCH', `/v1/admin/users/${id}/permissions`, admin, payload);

    const granted = await patch(SEED_IDS.userStaff, { can_create_stores: true, store_limit: 4 });
    expect(granted.json<UserJson>()).toMatchObject({ can_create_stores: true, store_limit: 4 });
    const onlyLimit = await patch(SEED_IDS.userStaff, { store_limit: 1 });
    expect(onlyLimit.json<UserJson>()).toMatchObject({ can_create_stores: true, store_limit: 1 });
    const revoked = await patch(SEED_IDS.userStaff, { can_create_stores: false });
    expect(revoked.statusCode).toBe(422);
    expect(revoked.json()).toMatchObject({ code: 'ADMIN_INVALID_LIMIT' });
    const clean = await patch(SEED_IDS.userStaff, { can_create_stores: false, store_limit: 0 });
    expect(clean.json<UserJson>()).toMatchObject({ can_create_stores: false, store_limit: 0 });
    expect((await patch(uid(KIND.user, 999), { store_limit: 0 })).statusCode).toBe(404);
    expect((await patch(SEED_IDS.userStaff, {})).statusCode).toBe(400);
  });

  it('suspender derruba as sessões na hora, sem apagar dados; reativar devolve o acesso', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const staff = await login(server, STAFF);
    expect((await call(server, 'GET', '/v1/team', staff, undefined, A)).statusCode).toBe(200);

    const suspended = await call(
      server,
      'POST',
      `/v1/admin/users/${SEED_IDS.userStaff}/suspend`,
      admin,
    );

    expect(suspended.json<UserJson>().status).toBe('SUSPENDED');
    expect((await call(server, 'GET', '/v1/team', staff, undefined, A)).statusCode).toBe(401);
    const sessions = await world.admin.query<{ open: string }>(
      'SELECT count(*) AS open FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [SEED_IDS.userStaff],
    );
    expect(sessions.rows[0]?.open).toBe('0');
    const membership = await world.admin.query('SELECT 1 FROM store_members WHERE user_id = $1', [
      SEED_IDS.userStaff,
    ]);
    expect(membership.rowCount).toBe(1);
    const otpsBefore = server.email.otps.length;
    const otp = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: STAFF },
    });
    await server.auth.flush();
    expect(otp.statusCode).toBe(202);
    expect(server.email.otps).toHaveLength(otpsBefore);

    const reactivated = await call(
      server,
      'POST',
      `/v1/admin/users/${SEED_IDS.userStaff}/reactivate`,
      admin,
    );
    expect(reactivated.json<UserJson>().status).toBe('ACTIVE');
    expect((await login(server, STAFF)).accessToken.length).toBeGreaterThan(20);
  });

  it('o administrador não suspende a si mesmo nem outro administrador; reativar exige conta suspensa', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const self = await call(server, 'POST', `/v1/admin/users/${SEED_IDS.userAdmin}/suspend`, admin);
    expect(self.statusCode).toBe(409);
    expect(self.json()).toMatchObject({ code: 'ADMIN_SELF_ACTION' });
    await world.admin.query('UPDATE users SET is_platform_admin = true WHERE id = $1', [
      SEED_IDS.userStaff,
    ]);
    const other = await call(
      server,
      'POST',
      `/v1/admin/users/${SEED_IDS.userStaff}/suspend`,
      admin,
    );
    expect(other.json()).toMatchObject({ code: 'ADMIN_ADMIN_PROTECTED' });
    const active = await call(
      server,
      'POST',
      `/v1/admin/users/${SEED_IDS.userOwner}/reactivate`,
      admin,
    );
    expect(active.json()).toMatchObject({ code: 'ADMIN_NOT_SUSPENDED' });
  });

  it('quem foi suspenso antes de entrar volta como convidado', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    await call(server, 'POST', `/v1/admin/users/${SEED_IDS.userInvited}/suspend`, admin);
    const back = await call(
      server,
      'POST',
      `/v1/admin/users/${SEED_IDS.userInvited}/reactivate`,
      admin,
    );
    expect(back.json<UserJson>().status).toBe('INVITED');
  });
});

describe('lojas', () => {
  it('lista com proprietário, plano, membros e status do WhatsApp', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    const list = (await call(server, 'GET', '/v1/admin/stores?limit=100', admin)).json<{
      items: StoreJson[];
    }>().items;

    const byName = new Map(list.map((s) => [s.name, s]));
    expect(byName.get('Cartas do Zé 🔥')).toMatchObject({
      city: 'São Paulo',
      plan: 'STANDARD',
      members_count: 2,
      whatsapp_status: 'ONLINE',
      owner: { email: OWNER },
    });
    expect(byName.get('Pokémon Açaí')).toMatchObject({ plan: 'PRO', member_limit: 10 });
    const search = (await call(server, 'GET', '/v1/admin/stores?q=curitiba', admin)).json<{
      items: StoreJson[];
    }>();
    expect(search.items.map((s) => s.name)).toEqual(['Pokémon Açaí']);
  });

  it('cria a loja para uma conta ativa: já nasce com o proprietário', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    const created = await call(server, 'POST', '/v1/admin/stores', admin, {
      name: 'Loja do Ash',
      city: 'Pallet',
      plan: 'PRO',
      member_limit: 3,
      owner_user_id: SEED_IDS.userStaff,
    });

    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{ store: StoreJson; owner_state: string }>();
    expect(body.owner_state).toBe('MEMBER');
    expect(body.store).toMatchObject({
      name: 'Loja do Ash',
      city: 'Pallet',
      plan: 'PRO',
      member_limit: 3,
      members_count: 1,
      owner: { email: STAFF },
    });
    const staff = await login(server, STAFF);
    const me = await call(server, 'GET', '/v1/store', staff, undefined, body.store.id);
    expect(me.json()).toMatchObject({ role: 'OWNER' });
    const owner = await call(
      server,
      'GET',
      '/v1/activity-log?limit=5',
      staff,
      undefined,
      body.store.id,
    );
    expect(owner.json<{ items: { action: string }[] }>().items[0]?.action).toBe('store.created');
  });

  it('com e-mail novo, convida o proprietário; ao aceitar ele vira OWNER', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    const created = await call(server, 'POST', '/v1/admin/stores', admin, {
      name: 'Loja da Misty',
      owner_email: 'Misty@Example.com',
    });
    await server.invitations.flush();

    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{ store: StoreJson; owner_state: string }>();
    expect(body.owner_state).toBe('INVITED');
    expect(body.store.owner).toBeNull();
    const invite = server.email.lastInvitationFor('misty@example.com');
    expect(invite).toMatchObject({ role: 'OWNER', storeName: 'Loja da Misty' });
    expect((await acceptInvitation(server, tokenFrom(invite?.link))).statusCode).toBe(200);

    const list = (await call(server, 'GET', '/v1/admin/stores?q=misty', admin)).json<{
      items: StoreJson[];
    }>();
    expect(list.items[0]?.owner?.email).toBe('misty@example.com');
  });

  it('recusa dono inexistente, sem conta ativa ou suspenso, e exige um dos dois campos', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const post = (payload: unknown) => call(server, 'POST', '/v1/admin/stores', admin, payload);

    expect((await post({ name: 'X', owner_user_id: uid(KIND.user, 999) })).json()).toMatchObject({
      code: 'ADMIN_OWNER_NOT_FOUND',
    });
    expect((await post({ name: 'X', owner_user_id: SEED_IDS.userInvited })).json()).toMatchObject({
      code: 'ADMIN_OWNER_NOT_ACTIVE',
    });
    expect((await post({ name: 'X', owner_email: 'suspenso@example.com' })).json()).toMatchObject({
      code: 'ADMIN_OWNER_SUSPENDED',
    });
    expect((await post({ name: 'X' })).statusCode).toBe(400);
    expect(
      (await post({ name: 'X', owner_email: 'a@example.com', owner_user_id: SEED_IDS.userStaff }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post({ name: 'X', owner_email: 'a@example.com', plan: 'minusculo' })).statusCode,
    ).toBe(400);
    const stores = await world.admin.query("SELECT 1 FROM stores WHERE name = 'X'");
    expect(stores.rowCount).toBe(0);
  });

  it('converte a solicitação de acesso ao criar a loja, e só uma vez', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    const created = await call(server, 'POST', '/v1/admin/stores', admin, {
      name: 'Cartas do Gary',
      owner_email: 'gary@example.com',
      access_request_id: PENDING_REQUEST,
    });

    expect(created.statusCode, created.body).toBe(201);
    const storeId = created.json<{ store: StoreJson }>().store.id;
    const row = await world.admin.query<{ status: string; converted_store_id: string }>(
      'SELECT status, converted_store_id FROM access_requests WHERE id = $1',
      [PENDING_REQUEST],
    );
    expect(row.rows[0]).toEqual({ status: 'CONVERTED', converted_store_id: storeId });
    const again = await call(server, 'POST', '/v1/admin/stores', admin, {
      name: 'Outra',
      owner_email: 'gary@example.com',
      access_request_id: PENDING_REQUEST,
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'ADMIN_REQUEST_NOT_PENDING' });
    const none = await world.admin.query("SELECT 1 FROM stores WHERE name = 'Outra'");
    expect(none.rowCount).toBe(0);
  });

  it('transfere a propriedade: o atual vira funcionário e a loja segue com um proprietário', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    const moved = await call(server, 'POST', `/v1/admin/stores/${A}/transfer-ownership`, admin, {
      new_owner_user_id: SEED_IDS.userStaff,
    });

    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json<StoreJson>().owner?.email).toBe(STAFF);
    const roles = await world.admin.query<{ email: string; role: string }>(
      `SELECT u.email, m.role FROM store_members m JOIN users u ON u.id = m.user_id
        WHERE m.store_id = $1 ORDER BY u.email`,
      [A],
    );
    expect(roles.rows).toEqual([
      { email: OWNER, role: 'STAFF' },
      { email: STAFF, role: 'OWNER' },
    ]);
    const owner = await login(server, OWNER);
    expect((await call(server, 'GET', '/v1/activity-log', owner, undefined, A)).statusCode).toBe(
      403,
    );
    const newOwner = await login(server, STAFF);
    const log = await call(server, 'GET', '/v1/activity-log?limit=3', newOwner, undefined, A);
    expect(log.json<{ items: { action: string }[] }>().items[0]?.action).toBe(
      'ownership.transferred',
    );
  });

  it('transfere para quem ainda não é da loja (entra como proprietário)', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const moved = await call(server, 'POST', `/v1/admin/stores/${C}/transfer-ownership`, admin, {
      new_owner_user_id: SEED_IDS.userStaff,
    });
    expect(moved.json<StoreJson>().owner?.email).toBe(STAFF);
    const owners = await world.admin.query(
      "SELECT 1 FROM store_members WHERE store_id = $1 AND role = 'OWNER'",
      [C],
    );
    expect(owners.rowCount).toBe(1);
  });

  it('recusa novo dono inativo, o que já é dono e loja inexistente', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const move = (storeId: string, userId: string) =>
      call(server, 'POST', `/v1/admin/stores/${storeId}/transfer-ownership`, admin, {
        new_owner_user_id: userId,
      });

    expect((await move(A, SEED_IDS.userSuspended)).json()).toMatchObject({
      code: 'ADMIN_OWNER_NOT_ACTIVE',
    });
    expect((await move(A, SEED_IDS.userInvited)).statusCode).toBe(422);
    expect((await move(A, SEED_IDS.userOwner)).json()).toMatchObject({
      code: 'ADMIN_ALREADY_OWNER',
    });
    expect((await move(uid(KIND.store, 999), SEED_IDS.userStaff)).statusCode).toBe(404);
    expect((await move(A, uid(KIND.user, 999))).statusCode).toBe(422);
    const owners = await world.admin.query(
      "SELECT 1 FROM store_members WHERE store_id = $1 AND role = 'OWNER'",
      [A],
    );
    expect(owners.rowCount).toBe(1);
  });

  it('nunca existem zero proprietários, nem com transferências e remoções ao mesmo tempo', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const owner = await login(server, OWNER);
    const ownerMember = await world.admin.query<{ id: string }>(
      'SELECT id FROM store_members WHERE store_id = $1 AND user_id = $2',
      [A, SEED_IDS.userOwner],
    );

    const results = await Promise.all([
      call(server, 'POST', `/v1/admin/stores/${A}/transfer-ownership`, admin, {
        new_owner_user_id: SEED_IDS.userStaff,
      }),
      call(server, 'DELETE', `/v1/team/${ownerMember.rows[0]?.id}`, owner, undefined, A),
      call(server, 'POST', `/v1/admin/stores/${A}/transfer-ownership`, admin, {
        new_owner_user_id: SEED_IDS.userOtherOwner,
      }),
    ]);

    expect(results.map((r) => r.statusCode).every((c) => c < 500)).toBe(true);
    const owners = await world.admin.query(
      "SELECT 1 FROM store_members WHERE store_id = $1 AND role = 'OWNER'",
      [A],
    );
    expect(owners.rowCount).toBeGreaterThanOrEqual(1);
  });

  it('o limite de membros definido pela administração vale para os convites da loja', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await world.admin.query('UPDATE stores SET member_limit = 2 WHERE id = $1', [A]);

    const refused = await call(
      server,
      'POST',
      '/v1/team/invitations',
      owner,
      { email: 'novo@example.com' },
      A,
    );
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'MEMBER_LIMIT_REACHED' });

    await world.admin.query('UPDATE stores SET member_limit = 4 WHERE id = $1', [A]);
    const accepted = await call(
      server,
      'POST',
      '/v1/team/invitations',
      owner,
      { email: 'novo@example.com' },
      A,
    );
    expect(accepted.statusCode).toBe(201);
    const second = await call(
      server,
      'POST',
      '/v1/team/invitations',
      owner,
      { email: 'outro@example.com' },
      A,
    );
    expect(second.statusCode).toBe(409);
  });
});

describe('convites da plataforma', () => {
  async function accountInvite(server: TestApp, admin: Session, email: string) {
    await call(server, 'POST', '/v1/admin/users', admin, { email });
    await server.invitations.flush();
    return tokenFrom(server.email.lastInvitationFor(email)?.link);
  }

  it('lista com tipo, loja, expiração e estado', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const list = async (query = '') =>
      (await call(server, 'GET', `/v1/admin/invitations?limit=100${query}`, admin)).json<{
        items: { kind: string; state: string; store: { name: string } | null }[];
      }>().items;

    const all = await list();
    expect(all.length).toBeGreaterThan(2);
    expect((await list('&status=REVOKED')).every((i) => i.state === 'REVOKED')).toBe(true);
    expect((await list('&status=EXPIRED')).every((i) => i.state === 'EXPIRED')).toBe(true);
    expect((await list('&kind=ACCOUNT')).every((i) => i.store === null)).toBe(true);
    expect((await list('&kind=STAFF')).every((i) => i.kind === 'STAFF' && i.store !== null)).toBe(
      true,
    );
    expect((await call(server, 'GET', '/v1/admin/invitations?kind=X', admin)).statusCode).toBe(400);
  });

  it('reenviar revoga o anterior: só o token novo é aceito', async () => {
    const server = await start({ INVITATION_RESEND_SECONDS: '0' });
    const admin = await login(server, ADMIN);
    const oldToken = await accountInvite(server, admin, 'reenvio@example.com');
    const pending = await world.admin.query<{ id: string }>(
      "SELECT id FROM invitations WHERE email = 'reenvio@example.com' AND status = 'PENDING'",
    );

    const resent = await call(
      server,
      'POST',
      `/v1/admin/invitations/${pending.rows[0]?.id}/resend`,
      admin,
    );
    await server.invitations.flush();

    expect(resent.statusCode, resent.body).toBe(200);
    const newToken = tokenFrom(server.email.lastInvitationFor('reenvio@example.com')?.link);
    expect(newToken).not.toBe(oldToken);
    expect((await acceptInvitation(server, oldToken)).statusCode).toBe(404);
    expect((await acceptInvitation(server, newToken)).statusCode).toBe(200);
    const again = await call(
      server,
      'POST',
      `/v1/admin/invitations/${pending.rows[0]?.id}/resend`,
      admin,
    );
    expect(again.statusCode).toBe(409);
  });

  it('reenviar um convite de conta não derruba os convites de loja da mesma pessoa', async () => {
    const server = await start({ INVITATION_RESEND_SECONDS: '0' });
    const admin = await login(server, ADMIN);
    const owner = await login(server, OWNER);
    await call(server, 'POST', '/v1/team/invitations', owner, { email: 'dupla@example.com' }, A);
    await accountInvite(server, admin, 'dupla@example.com');
    const account = await world.admin.query<{ id: string }>(
      "SELECT id FROM invitations WHERE email = 'dupla@example.com' AND store_id IS NULL AND status = 'PENDING'",
    );

    await call(server, 'POST', `/v1/admin/invitations/${account.rows[0]?.id}/resend`, admin);

    const storeInvite = await world.admin.query(
      "SELECT 1 FROM invitations WHERE email = 'dupla@example.com' AND store_id = $1 AND status = 'PENDING'",
      [A],
    );
    expect(storeInvite.rowCount).toBe(1);
  });

  it('respeita o intervalo mínimo entre reenvios', async () => {
    const server = await start({ INVITATION_RESEND_SECONDS: '3600' });
    const admin = await login(server, ADMIN);
    await accountInvite(server, admin, 'cedo@example.com');
    const pending = await world.admin.query<{ id: string }>(
      "SELECT id FROM invitations WHERE email = 'cedo@example.com' AND status = 'PENDING'",
    );
    const response = await call(
      server,
      'POST',
      `/v1/admin/invitations/${pending.rows[0]?.id}/resend`,
      admin,
    );
    expect(response.statusCode).toBe(429);
  });

  it('revogar impede o aceite; repetir ou revogar o que não existe falha', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const token = await accountInvite(server, admin, 'revogado@example.com');
    const pending = await world.admin.query<{ id: string }>(
      "SELECT id FROM invitations WHERE email = 'revogado@example.com' AND status = 'PENDING'",
    );
    const id = pending.rows[0]?.id ?? '';

    expect((await call(server, 'DELETE', `/v1/admin/invitations/${id}`, admin)).statusCode).toBe(
      204,
    );
    expect((await acceptInvitation(server, token)).statusCode).toBe(404);
    expect((await call(server, 'DELETE', `/v1/admin/invitations/${id}`, admin)).statusCode).toBe(
      409,
    );
    expect(
      (await call(server, 'DELETE', `/v1/admin/invitations/${uid(KIND.invitation, 999)}`, admin))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(server, 'POST', `/v1/admin/invitations/${id}/resend`, admin)).statusCode,
    ).toBe(409);
  });
});

describe('solicitações de acesso', () => {
  const request = (server: TestApp, payload: unknown, ip = '203.0.113.50') =>
    server.app.inject({
      method: 'POST',
      url: '/v1/public/access-requests',
      payload: payload as Record<string, unknown>,
      remoteAddress: ip,
    });
  const valid = (overrides: Record<string, unknown> = {}) => ({
    name: 'Brock',
    email: 'Brock@Example.com',
    whatsapp: '(11) 98888-0002',
    store_name: 'Pedra & Cartas',
    message: 'Quero vender cartas em leilão.',
    ...overrides,
  });

  it('recebe o pedido sem criar usuário nem loja e sem enviar e-mail', async () => {
    const server = await start();
    const usersBefore = await world.admin.query('SELECT 1 FROM users');
    const storesBefore = await world.admin.query('SELECT 1 FROM stores');

    const response = await request(server, valid());

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ status: 'RECEIVED' });
    const row = await world.admin.query<{
      email: string;
      whatsapp: string;
      status: string;
      ip_hash: string;
    }>(
      "SELECT email, whatsapp, status, ip_hash FROM access_requests WHERE email = 'brock@example.com'",
    );
    expect(row.rows[0]).toMatchObject({
      email: 'brock@example.com',
      whatsapp: '5511988880002',
      status: 'PENDING',
    });
    expect(row.rows[0]?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0]?.ip_hash).not.toContain('203.0.113.50');
    expect((await world.admin.query('SELECT 1 FROM users')).rowCount).toBe(usersBefore.rowCount);
    expect((await world.admin.query('SELECT 1 FROM stores')).rowCount).toBe(storesBefore.rowCount);
    expect(server.email.invitations).toHaveLength(0);
    expect(server.email.otps).toHaveLength(0);
  });

  it('pedido repetido responde igual e não duplica; o campo-isca descarta sem avisar', async () => {
    const server = await start();
    const first = await request(server, valid());
    const again = await request(server, valid({ name: 'Brock de novo' }), '203.0.113.51');
    const bot = await request(
      server,
      valid({ email: 'bot@example.com', website: 'http://spam.example' }),
    );

    expect(again.body).toBe(first.body);
    expect(bot.body).toBe(first.body);
    expect(bot.statusCode).toBe(202);
    const rows = await world.admin.query(
      "SELECT email FROM access_requests WHERE email IN ('brock@example.com', 'bot@example.com')",
    );
    expect(rows.rows).toEqual([{ email: 'brock@example.com' }]);
    // O e-mail já em análise (do seed) também responde igual.
    const seeded = await request(server, valid({ email: 'gary@example.com' }), '203.0.113.52');
    expect(seeded.body).toBe(first.body);
  });

  it('valida o corpo e limita o tamanho', async () => {
    const server = await start();
    for (const bad of [
      valid({ email: 'nao-e-email' }),
      valid({ name: '' }),
      valid({ store_name: 'x'.repeat(121) }),
      valid({ message: 'x'.repeat(1001) }),
      valid({ extra: 'campo desconhecido' }),
      { name: 'Sem loja', email: 'a@example.com' },
    ]) {
      expect((await request(server, bad)).statusCode).toBe(
        bad['extra' as never] === undefined ? 400 : 202,
      );
    }
    expect((await request(server, valid({ whatsapp: '12' }))).statusCode).toBe(422);
  });

  it('o mesmo IP não passa de 10 pedidos por dia; o excedente é descartado em silêncio', async () => {
    const server = await start();
    for (let i = 0; i < 12; i += 1) {
      const response = await request(
        server,
        valid({ email: `pedido${i}@example.com` }),
        '198.51.100.9',
      );
      expect(response.statusCode).toBe(202);
    }
    const stored = await world.admin.query(
      "SELECT 1 FROM access_requests WHERE email LIKE 'pedido%@example.com'",
    );
    expect(stored.rowCount).toBe(10);
    const other = await request(server, valid({ email: 'outro-ip@example.com' }), '198.51.100.10');
    expect(other.statusCode).toBe(202);
    expect(
      (
        await world.admin.query(
          "SELECT 1 FROM access_requests WHERE email = 'outro-ip@example.com'",
        )
      ).rowCount,
    ).toBe(1);
  });

  it('tem limite de requisições por minuto próprio (429)', async () => {
    const server = await start({ RATE_LIMIT_ACCESS_REQUEST_PER_MINUTE: '2' });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      statuses.push(
        (await request(server, valid({ email: `rl${i}@example.com` }), '192.0.2.20')).statusCode,
      );
    }
    expect(statuses).toEqual([202, 202, 429, 429]);
  });

  it('a rota pública não grava dado pessoal em log nem expõe os pedidos', async () => {
    const server = await start();
    await request(server, valid());
    const get = await server.app.inject({ method: 'GET', url: '/v1/public/access-requests' });
    expect(get.statusCode).toBeGreaterThanOrEqual(400);
    expect(get.body).not.toContain('brock');
    const asStore = await world.appPool
      .query('SELECT * FROM access_requests')
      .catch((e: { code: string }) => e);
    // Sem contexto de administrador, o RLS não deixa ler nenhuma linha.
    expect(
      Array.isArray((asStore as { rows?: unknown[] }).rows)
        ? (asStore as { rows: unknown[] }).rows
        : [],
    ).toHaveLength(0);
  });

  it('o administrador lista, filtra e recusa; recusar duas vezes é 409', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const list = async (query = '') =>
      (await call(server, 'GET', `/v1/admin/access-requests?limit=50${query}`, admin)).json<{
        items: { id: string; status: string; email: string }[];
      }>().items;

    expect((await list()).map((r) => r.status).sort((a, b) => a.localeCompare(b))).toEqual([
      'CONVERTED',
      'PENDING',
      'REFUSED',
    ]);
    expect((await list('&status=PENDING')).map((r) => r.email)).toEqual(['gary@example.com']);

    const refused = await call(
      server,
      'POST',
      `/v1/admin/access-requests/${PENDING_REQUEST}/refuse`,
      admin,
    );
    expect(refused.statusCode).toBe(204);
    expect(await list('&status=REFUSED')).toHaveLength(2);
    const again = await call(
      server,
      'POST',
      `/v1/admin/access-requests/${PENDING_REQUEST}/refuse`,
      admin,
    );
    expect(again.statusCode).toBe(409);
    expect(
      (
        await call(
          server,
          'POST',
          `/v1/admin/access-requests/${uid(KIND.request, 999)}/refuse`,
          admin,
        )
      ).statusCode,
    ).toBe(404);
    expect(server.email.invitations).toHaveLength(0);
  });
});

describe('painel da plataforma (GET /v1/admin/dashboard)', () => {
  it('mostra KPIs agregados e as lojas com WhatsApp desconectado', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    const response = await call(server, 'GET', '/v1/admin/dashboard', admin);

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      kpis: Record<string, number>;
      disconnected_stores: { id: string; name: string; whatsapp_status: string }[];
    }>();
    const expected = await world.admin.query<{ users: string; invitations: string }>(
      `SELECT (SELECT count(*) FROM users WHERE status = 'ACTIVE') AS users,
              (SELECT count(*) FROM invitations WHERE status = 'PENDING' AND expires_at > now()) AS invitations`,
    );
    expect(body.kpis).toEqual({
      active_users: Number(expected.rows[0]?.users),
      stores: 3,
      pending_invitations: Number(expected.rows[0]?.invitations),
      new_access_requests: 1,
      pending_plan_requests: 1,
    });
    expect(
      body.disconnected_stores
        .map((s) => [s.id, s.whatsapp_status])
        .sort((a, b) => a[0]!.localeCompare(b[0]!)),
    ).toEqual(
      [
        [B, 'QR_READY'],
        [C, 'OFFLINE'],
      ].sort((a, b) => a[0]!.localeCompare(b[0]!)),
    );
  });

  it('o administrador, mesmo com contexto de plataforma, não lê tabela de loja (RLS)', async () => {
    const server = await start();
    const { withContext } = await import('../src/db/context.js');
    const { sql } = await import('drizzle-orm');
    for (const table of [
      'cards_inventory',
      'customers',
      'auctions',
      'bids',
      'settlements',
      'shipments',
      'public_links',
    ]) {
      const rows = await withContext(
        server.db,
        { userId: SEED_IDS.userAdmin, isPlatformAdmin: true },
        (tx) => tx.execute<{ n: string }>(sql.raw(`SELECT count(*) AS n FROM ${table}`)),
      );
      expect(rows.rows[0]?.n, table).toBe('0');
    }
  });
});
