import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, SEED_LINK_TOKENS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/**
 * Sprint 08: preferências do perfil, notificações internas, plano da loja e vitrine pública.
 * Postgres real, papel `app_api` (RLS valendo).
 */

let world: World;
let app: TestApp | undefined;

const ADMIN = 'admin@example.com';
const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const customer = (n: number) => uid(KIND.customer, n);
const card = (n: number) => uid(KIND.card, n);
const notification = (n: number) => uid(KIND.notification, n);

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

describe('preferências do perfil (/v1/me/preferences)', () => {
  it('devolve o padrão de quem nunca mexeu e o que está salvo para quem mexeu', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);

    expect((await call(server, 'GET', '/v1/me/preferences', owner)).json()).toEqual({
      language: 'pt-BR',
      theme: 'SYSTEM',
      timezone: 'America/Sao_Paulo',
      currency: 'BRL',
      notifications: { in_app: true, email: false },
    });
    expect((await call(server, 'GET', '/v1/me/preferences', staff)).json()).toMatchObject({
      language: 'en',
      theme: 'DARK',
      timezone: 'America/Manaus',
    });
  });

  it('altera só o que for enviado e junta as notificações', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const first = await call(server, 'PATCH', '/v1/me/preferences', owner, {
      language: 'en',
      notifications: { email: true },
    });
    expect(first.json()).toMatchObject({
      language: 'en',
      theme: 'SYSTEM',
      notifications: { in_app: true, email: true },
    });
    const second = await call(server, 'PATCH', '/v1/me/preferences', owner, {
      theme: 'LIGHT',
      timezone: 'UTC',
      notifications: { in_app: false },
    });
    expect(second.json()).toEqual({
      language: 'en',
      theme: 'LIGHT',
      timezone: 'UTC',
      currency: 'BRL',
      notifications: { in_app: false, email: true },
    });
    const again = await call(server, 'GET', '/v1/me/preferences', owner);
    expect(again.json()).toEqual(second.json());
  });

  it('recusa fuso, idioma, tema e moeda fora da lista, e corpo vazio', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const patch = (payload: unknown) => call(server, 'PATCH', '/v1/me/preferences', owner, payload);

    const timezone = await patch({ timezone: 'Marte/Olympus' });
    expect(timezone.statusCode).toBe(422);
    expect(timezone.json()).toMatchObject({ code: 'INVALID_TIMEZONE' });
    for (const bad of [
      { language: 'fr' },
      { theme: 'ROXO' },
      { currency: 'USD' },
      {},
      { notifications: {} },
      { notifications: { in_app: 'sim' } },
    ]) {
      expect((await patch(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await call(server, 'GET', '/v1/me/preferences', owner)).json()).toMatchObject({
      timezone: 'America/Sao_Paulo',
    });
  });

  it('cada pessoa altera só as próprias preferências e precisa estar logada', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await call(server, 'PATCH', '/v1/me/preferences', owner, { theme: 'DARK' });
    const staff = await login(server, STAFF);
    expect((await call(server, 'GET', '/v1/me/preferences', staff)).json()).toMatchObject({
      theme: 'DARK',
      language: 'en',
    });
    const anonymous = await server.app.inject({ method: 'GET', url: '/v1/me/preferences' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('notificações internas (/v1/notifications)', () => {
  interface Item {
    id: string;
    kind: string;
    read: boolean;
    data: Record<string, string>;
  }
  const list = async (server: TestApp, session: Session, query = '', store = A) =>
    (
      await call(server, 'GET', `/v1/notifications?limit=50${query}`, session, undefined, store)
    ).json<{
      items: Item[];
      next_cursor: string | null;
    }>();

  it('lista os avisos da loja com o estado de leitura de quem pergunta', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);

    const forOwner = await list(server, owner);
    const forStaff = await list(server, staff);

    expect(forOwner.items.map((i) => [i.id, i.read])).toEqual([
      [notification(2), false],
      [notification(1), true],
    ]);
    expect(forStaff.items.map((i) => i.read)).toEqual([false, false]);
    expect(forOwner.items.find((i) => i.id === notification(1))?.kind).toBe('POLL_CEILING_REACHED');
    expect((await list(server, owner, '&unread=true')).items.map((i) => i.id)).toEqual([
      notification(2),
    ]);
  });

  it('conta, marca uma e marca todas como lidas, sem afetar os outros', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    const count = async (session: Session) =>
      (await call(server, 'GET', '/v1/notifications/unread-count', session, undefined, A)).json<{
        count: number;
      }>().count;
    expect([await count(owner), await count(staff)]).toEqual([1, 2]);

    const one = await call(
      server,
      'POST',
      `/v1/notifications/${notification(2)}/read`,
      owner,
      undefined,
      A,
    );
    expect(one.statusCode).toBe(204);
    expect(
      (await call(server, 'POST', `/v1/notifications/${notification(2)}/read`, owner, undefined, A))
        .statusCode,
    ).toBe(204);
    expect([await count(owner), await count(staff)]).toEqual([0, 2]);

    const all = await call(server, 'POST', '/v1/notifications/read-all', staff, undefined, A);
    expect(all.json()).toEqual({ marked: 2 });
    expect([await count(owner), await count(staff)]).toEqual([0, 0]);
    expect(
      (await call(server, 'POST', '/v1/notifications/read-all', staff, undefined, A)).json(),
    ).toEqual({
      marked: 0,
    });
  });

  it('aviso de outra loja não aparece e não pode ser marcado', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);

    expect((await list(server, staff)).items.some((i) => i.id === notification(3))).toBe(false);
    const foreign = await call(
      server,
      'POST',
      `/v1/notifications/${notification(3)}/read`,
      staff,
      undefined,
      A,
    );
    expect(foreign.statusCode).toBe(404);
    expect((await call(server, 'GET', '/v1/notifications', staff, undefined, B)).statusCode).toBe(
      403,
    );
    expect((await list(server, owner, '', B)).items.map((i) => i.id)).toEqual([notification(3)]);
    const reads = await world.admin.query(
      'SELECT 1 FROM notification_reads WHERE notification_id = $1',
      [notification(3)],
    );
    expect(reads.rowCount).toBe(0);
  });

  it('pagina por cursor e rejeita cursor inválido', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const first = await call(server, 'GET', '/v1/notifications?limit=1', owner, undefined, A);
    const page = first.json<{ items: Item[]; next_cursor: string | null }>();
    expect(page.items).toHaveLength(1);
    const rest = await call(
      server,
      'GET',
      `/v1/notifications?limit=5&cursor=${page.next_cursor}`,
      owner,
      undefined,
      A,
    );
    expect(rest.json<{ items: Item[] }>().items.map((i) => i.id)).toEqual([notification(1)]);
    expect(
      (await call(server, 'GET', '/v1/notifications?cursor=lixo', owner, undefined, A)).statusCode,
    ).toBe(400);
  });

  it('a enquete que chega ao teto avisa a loja', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const created = await call(
      server,
      'POST',
      '/v1/auctions',
      owner,
      {
        card_id: card(12),
        type: 'POLL',
        end_time: new Date(Date.now() + 3_600_000).toISOString(),
        initial_bid: '10.00',
        min_increment: '5.00',
        max_poll_value: '30.00',
      },
      A,
    );
    const auctionId = created.json<{ id: string }>().id;
    await call(
      server,
      'POST',
      `/v1/auctions/${auctionId}/bids`,
      owner,
      { customer_id: customer(7), amount: '20.00' },
      A,
    );
    expect((await list(server, owner, '&unread=true')).items).toHaveLength(1);

    await call(
      server,
      'POST',
      `/v1/auctions/${auctionId}/bids`,
      owner,
      { customer_id: customer(8), amount: '30.00' },
      A,
    );

    const unread = (await list(server, owner, '&unread=true')).items;
    expect(unread).toHaveLength(2);
    expect(unread[0]).toMatchObject({
      kind: 'POLL_CEILING_REACHED',
      data: { auction_id: auctionId },
    });
  });

  it('o comprador que envia os dados pela página pública avisa a loja, só com ids', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await world.admin.query('DELETE FROM notifications');

    const submitted = await server.app.inject({
      method: 'POST',
      url: '/v1/public/settlement/data',
      remoteAddress: '203.0.113.77',
      payload: {
        token: SEED_LINK_TOKENS.settlement,
        cpf: '529.982.247-25',
        address: {
          zip: '01310-100',
          street: 'Avenida Paulista',
          number: '1',
          city: 'São Paulo',
          state: 'SP',
        },
        consent: { accepted: true, version: 'v1' },
      },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);

    const items = (await list(server, owner)).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'BUYER_DATA_SUBMITTED' });
    expect(JSON.stringify(items[0]?.data)).not.toMatch(/52998224725|Paulista/);
  });

  it('exige login e participação na loja', async () => {
    const server = await start();
    const anonymous = await server.app.inject({ method: 'GET', url: '/v1/notifications' });
    expect(anonymous.statusCode).toBe(401);
    const admin = await login(server, ADMIN);
    expect((await call(server, 'GET', '/v1/notifications', admin, undefined, A)).statusCode).toBe(
      403,
    );
  });
});

describe('plano da loja (/v1/plan)', () => {
  it('mostra o plano, os limites, o uso e o pedido pendente', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'GET', '/v1/plan', staff, undefined, A);

    expect(response.statusCode, response.body).toBe(200);
    const plan = response.json<{
      plan: string;
      limits: { members: number; cards: number | null; groups: number };
      usage: { members: number; cards: number; groups: number; pending_invitations: number };
      pending_request: { requested_plan: string } | null;
    }>();
    expect(plan.plan).toBe('STANDARD');
    expect(plan.limits).toEqual({ members: 5, cards: 500, groups: 1 });
    expect(plan.usage).toMatchObject({ members: 2, cards: 60, groups: 1 });
    expect(plan.pending_request).toMatchObject({ requested_plan: 'PRO' });
  });

  it('só o proprietário pede a mudança; pedir de novo atualiza o pedido pendente', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    const url = '/v1/plan/change-requests';

    expect((await call(server, 'POST', url, staff, { requested_plan: 'PRO' }, A)).statusCode).toBe(
      403,
    );
    const first = await call(
      server,
      'POST',
      url,
      owner,
      { requested_plan: 'ENTERPRISE', message: 'Mais cartas, por favor.' },
      A,
    );
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ requested_plan: 'ENTERPRISE', status: 'PENDING' });
    const second = await call(
      server,
      'POST',
      url,
      owner,
      { message: 'Só preciso de mais cartas.' },
      A,
    );
    expect(second.json()).toMatchObject({
      requested_plan: null,
      message: 'Só preciso de mais cartas.',
    });

    const pending = await world.admin.query(
      "SELECT 1 FROM plan_change_requests WHERE store_id = $1 AND status = 'PENDING'",
      [A],
    );
    expect(pending.rowCount).toBe(1);
    expect(
      (await call(server, 'POST', url, owner, { requested_plan: 'minusculo' }, A)).statusCode,
    ).toBe(400);
    const log = await call(server, 'GET', '/v1/activity-log?limit=3', owner, undefined, A);
    expect(log.json<{ items: { action: string }[] }>().items[0]?.action).toBe(
      'plan.change_requested',
    );
  });

  it('o pedido chega ao administrador, que aplica e muda o plano e os limites', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const pending = (
      await call(server, 'GET', '/v1/admin/plan-requests?status=PENDING', admin)
    ).json<{
      items: { id: string; store: { id: string; current_plan: string }; requested_plan: string }[];
    }>().items;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      store: { id: A, current_plan: 'STANDARD' },
      requested_plan: 'PRO',
    });
    const dashboard = await call(server, 'GET', '/v1/admin/dashboard', admin);
    expect(dashboard.json<{ kpis: Record<string, number> }>().kpis['pending_plan_requests']).toBe(
      1,
    );

    const applied = await call(
      server,
      'POST',
      `/v1/admin/plan-requests/${pending[0]?.id}/resolve`,
      admin,
      {
        decision: 'APPLY',
        member_limit: 8,
        card_limit: null,
      },
    );

    expect(applied.statusCode, applied.body).toBe(204);
    const owner = await login(server, OWNER);
    const plan = (await call(server, 'GET', '/v1/plan', owner, undefined, A)).json<{
      plan: string;
      limits: { members: number; cards: number | null };
      pending_request: unknown;
    }>();
    expect(plan).toMatchObject({
      plan: 'PRO',
      limits: { members: 8, cards: null },
      pending_request: null,
    });
    expect(
      (
        await call(server, 'POST', `/v1/admin/plan-requests/${pending[0]?.id}/resolve`, admin, {
          decision: 'REFUSE',
        })
      ).statusCode,
    ).toBe(409);
  });

  it('o administrador recusa sem mudar nada; plano inexistente do pedido é 404', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const refused = await call(
      server,
      'POST',
      `/v1/admin/plan-requests/${uid(KIND.planRequest, 1)}/resolve`,
      admin,
      { decision: 'REFUSE' },
    );
    expect(refused.statusCode).toBe(204);
    const row = await world.admin.query<{ plan: string }>('SELECT plan FROM stores WHERE id = $1', [
      A,
    ]);
    expect(row.rows[0]?.plan).toBe('STANDARD');
    const missing = await call(
      server,
      'POST',
      `/v1/admin/plan-requests/${uid(KIND.planRequest, 99)}/resolve`,
      admin,
      { decision: 'REFUSE' },
    );
    expect(missing.statusCode).toBe(404);
    const owner = await login(server, OWNER);
    expect(
      (await call(server, 'GET', '/v1/admin/plan-requests', owner, undefined, A)).statusCode,
    ).toBe(403);
  });

  it('o administrador muda o plano direto, sem baixar o limite de membros abaixo do uso', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);
    const patch = (payload: unknown) =>
      call(server, 'PATCH', `/v1/admin/stores/${A}/plan`, admin, payload);

    const ok = await patch({ plan: 'PRO', member_limit: 6, card_limit: 100 });
    expect(ok.json()).toMatchObject({ plan: 'PRO', member_limit: 6, card_limit: 100 });
    const below = await patch({ member_limit: 1 });
    expect(below.statusCode).toBe(422);
    expect(below.json()).toMatchObject({ code: 'ADMIN_LIMIT_BELOW_USAGE' });
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ plan: 'pro' })).statusCode).toBe(400);
    const missing = await call(
      server,
      'PATCH',
      `/v1/admin/stores/${uid(KIND.store, 99)}/plan`,
      admin,
      { plan: 'PRO' },
    );
    expect(missing.statusCode).toBe(404);
  });

  it('o limite de cartas do plano barra o cadastro; sem limite é ilimitado', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const body = { tcgdex_id: 'seed-003', language: 'PT', condition: 'NM', origin: 'OWN' };
    const total = (
      await world.admin.query<{ n: string }>(
        'SELECT count(*) AS n FROM cards_inventory WHERE store_id = $1',
        [A],
      )
    ).rows[0]?.n;
    await world.admin.query('UPDATE stores SET card_limit = $2 WHERE id = $1', [A, Number(total)]);

    const refused = await call(server, 'POST', '/v1/cards', owner, body, A);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'CARD_LIMIT_REACHED' });

    await world.admin.query('UPDATE stores SET card_limit = $2 WHERE id = $1', [
      A,
      Number(total) + 1,
    ]);
    expect((await call(server, 'POST', '/v1/cards', owner, body, A)).statusCode).toBe(201);
    expect((await call(server, 'POST', '/v1/cards', owner, body, A)).statusCode).toBe(409);
    await world.admin.query('UPDATE stores SET card_limit = NULL WHERE id = $1', [A]);
    expect((await call(server, 'POST', '/v1/cards', owner, body, A)).statusCode).toBe(201);
  });
});

describe('opt-in da vitrine (PATCH /v1/store)', () => {
  const invite = 'https://chat.whatsapp.com/ABCDEFGHIJKLMNOPQRSTUV';

  it('ligar exige o link do grupo e a confirmação de que ele ficará público', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const patch = (payload: unknown) => call(server, 'PATCH', '/v1/store', owner, payload, A);

    const noUrl = await patch({ showcase_enabled: true, acknowledge_public_group_link: true });
    expect(noUrl.statusCode).toBe(422);
    expect(noUrl.json()).toMatchObject({ code: 'INVITE_URL_REQUIRED' });
    const noAck = await patch({ showcase_enabled: true, whatsapp_invite_url: invite });
    expect(noAck.statusCode).toBe(422);
    expect(noAck.json()).toMatchObject({ code: 'SHOWCASE_ACK_REQUIRED' });
    const stored = await world.admin.query<{
      showcase_enabled: boolean;
      whatsapp_invite_url: string | null;
    }>('SELECT showcase_enabled, whatsapp_invite_url FROM stores WHERE id = $1', [A]);
    expect(stored.rows[0]).toEqual({ showcase_enabled: false, whatsapp_invite_url: null });

    const on = await patch({
      showcase_enabled: true,
      whatsapp_invite_url: invite,
      acknowledge_public_group_link: true,
    });
    expect(on.json()).toMatchObject({ showcase_enabled: true, whatsapp_invite_url: invite });
    const off = await patch({ showcase_enabled: false });
    expect(off.json()).toMatchObject({ showcase_enabled: false, whatsapp_invite_url: invite });
  });

  it('não deixa apagar o link com a vitrine ligada e valida o formato', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const patch = (payload: unknown) => call(server, 'PATCH', '/v1/store', owner, payload, B);

    expect((await patch({ whatsapp_invite_url: null })).json()).toMatchObject({
      code: 'INVITE_URL_REQUIRED',
    });
    for (const bad of [
      'https://chat.whatsapp.com.evil.example/ABCDEFGHIJKLMN',
      'https://evil.example/ABCDEFGHIJKLMN',
      'https://chat.whatsapp.com/curto',
    ]) {
      expect((await patch({ whatsapp_invite_url: bad })).statusCode, bad).toBe(400);
    }
    const staff = await login(server, STAFF);
    expect(
      (await call(server, 'PATCH', '/v1/store', staff, { showcase_enabled: false }, A)).statusCode,
    ).toBe(403);
  });
});

describe('vitrine pública (GET /v1/public/showcase)', () => {
  interface Item {
    store: { id: string; name: string; group_url: string };
    card: { short_code: string; name: string; language: string; image_url: string | null };
    current_bid: string | null;
    bid_count: number;
    ends_at: string;
  }
  const get = (server: TestApp, query = '', ip = '203.0.113.90') =>
    server.app.inject({ method: 'GET', url: `/v1/public/showcase${query}`, remoteAddress: ip });

  async function liveShowcase(server: TestApp) {
    await world.admin.query("UPDATE stores SET whatsapp_status = 'ONLINE' WHERE id = $1", [B]);
    return (await get(server)).json<{
      items: Item[];
      total: number;
      stores: { id: string; name: string }[];
    }>();
  }

  it('mostra só as lojas que optaram e estão com o WhatsApp conectado', async () => {
    const server = await start();

    const offline = (await get(server)).json<{ items: Item[] }>();
    expect(offline.items).toHaveLength(0);

    const live = await liveShowcase(server);
    expect(live.items.length).toBeGreaterThan(0);
    expect(live.items.every((i) => i.store.id === B)).toBe(true);
    expect(live.items[0]?.store).toMatchObject({
      name: 'Pokémon Açaí',
      group_url: 'https://chat.whatsapp.com/ABCDEFGHIJKLMNOPQRSTUV',
    });
    expect(live.stores).toEqual([{ id: B, name: 'Pokémon Açaí' }]);
    expect(live.items[0]?.current_bid).toMatch(/^\d+\.\d{2}$/);
    expect(live.items[0]?.card.image_url).toMatch(/^https:\/\/assets\.tcgdex\.net\//);
  });

  it('a loja que não optou nunca aparece, mesmo com leilão ativo', async () => {
    const server = await start();
    const before = await liveShowcase(server);
    expect(before.items.some((i) => i.store.id === A)).toBe(false);
    const active = await world.admin.query(
      "SELECT 1 FROM auctions WHERE store_id = $1 AND status = 'ACTIVE'",
      [A],
    );
    expect(active.rowCount).toBeGreaterThan(0);

    await world.admin.query(
      "UPDATE stores SET showcase_enabled = true, whatsapp_invite_url = 'https://chat.whatsapp.com/ZYXWVUTSRQPONMLKJIHG' WHERE id = $1",
      [A],
    );
    const after = (await get(server)).json<{ items: Item[] }>();
    expect(after.items.some((i) => i.store.id === A)).toBe(true);
    await world.admin.query('UPDATE stores SET showcase_enabled = false WHERE id = $1', [A]);
    expect((await get(server)).json<{ items: Item[] }>().items.some((i) => i.store.id === A)).toBe(
      false,
    );
  });

  it('não mostra leilão pendente, encerrado nem pausado', async () => {
    const server = await start();
    await world.admin.query("UPDATE stores SET whatsapp_status = 'ONLINE' WHERE id = $1", [B]);
    await world.admin.query("UPDATE auctions SET status = 'PAUSED_FOR_VALIDATION' WHERE id = $1", [
      uid(KIND.auction, 11),
    ]);
    expect((await get(server)).json<{ items: Item[] }>().items).toHaveLength(0);
    await world.admin.query(
      "UPDATE auctions SET status = 'ACTIVE', end_time = now() - interval '1 minute' WHERE id = $1",
      [uid(KIND.auction, 11)],
    );
    expect((await get(server)).json<{ items: Item[] }>().items).toHaveLength(0);
  });

  it('filtra por loja e idioma, ordena e respeita os tetos de página e deslocamento', async () => {
    const server = await start();
    await world.admin.query(
      "UPDATE stores SET showcase_enabled = true, whatsapp_invite_url = 'https://chat.whatsapp.com/ZYXWVUTSRQPONMLKJIHG' WHERE id = $1",
      [A],
    );
    const all = await liveShowcase(server);
    expect(all.stores.map((s) => s.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [A, B].sort((a, b) => a.localeCompare(b)),
    );

    const onlyB = (await get(server, `?store=${B}`)).json<{ items: Item[] }>();
    expect(onlyB.items.every((i) => i.store.id === B)).toBe(true);
    const english = (await get(server, '?language=EN')).json<{ items: Item[] }>();
    expect(english.items.every((i) => i.card.language === 'EN')).toBe(true);

    const byEnd = (await get(server, '?sort=ENDING_SOON'))
      .json<{ items: Item[] }>()
      .items.map((i) => Date.parse(i.ends_at));
    expect([...byEnd].sort((a, b) => a - b)).toEqual(byEnd);
    const byBid = (await get(server, '?sort=HIGHEST_BID'))
      .json<{ items: Item[] }>()
      .items.map((i) => Number(i.current_bid ?? 0));
    expect([...byBid].sort((a, b) => b - a)).toEqual(byBid);

    const page = (await get(server, '?limit=1')).json<{ items: Item[]; total: number }>();
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeGreaterThan(1);
    for (const bad of [
      '?limit=49',
      '?limit=0',
      '?offset=481',
      '?offset=-1',
      '?sort=RANDOM',
      '?language=pt',
      '?store=x',
    ]) {
      expect((await get(server, bad)).statusCode, bad).toBe(400);
    }
  });

  it('não expõe telefone, nome de cliente, e-mail nem dado interno', async () => {
    const server = await start();
    await world.admin.query(
      "UPDATE stores SET showcase_enabled = true, whatsapp_invite_url = 'https://chat.whatsapp.com/ZYXWVUTSRQPONMLKJIHG' WHERE id = $1",
      [A],
    );
    await liveShowcase(server);
    const response = await get(server, '?limit=48');
    const customers = await world.admin.query<{
      phone: string;
      name: string;
      email: string | null;
    }>('SELECT phone, name, email FROM customers');
    for (const c of customers.rows) {
      expect(response.body).not.toContain(c.phone);
      expect(response.body).not.toContain(c.name);
      if (c.email) expect(response.body).not.toContain(c.email);
    }
    expect(response.body).not.toMatch(/pix@|raw_whatsapp|session/);
  });

  it('é pública (sem login), cacheável por poucos segundos e tem limite por minuto', async () => {
    const server = await start({ RATE_LIMIT_SHOWCASE_PER_MINUTE: '2' });
    const first = await get(server, '', '192.0.2.31');
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('public, max-age=10');
    expect(first.headers['x-robots-tag']).toContain('noindex');
    expect((await get(server, '', '192.0.2.31')).statusCode).toBe(200);
    expect((await get(server, '', '192.0.2.31')).statusCode).toBe(429);
    expect((await get(server, '', '192.0.2.32')).statusCode).toBe(200);
  });

  it('o papel público executa a função da vitrine e continua sem ler nenhuma tabela', async () => {
    const client = await world.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE public_runtime');
      const ok = await client.query<{ page: object }>(
        'SELECT public_showcase_list(NULL, NULL, NULL, 5, 0) AS page',
      );
      expect(ok.rows[0]?.page).toHaveProperty('items');
      await expect(client.query('SELECT * FROM stores')).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
