import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/**
 * Sprint 01 (Etapa 2b): criar e editar loja, equipe, convites e log de atividades.
 * Tudo contra Postgres real, com o papel `app_api` (sem BYPASSRLS).
 */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const OTHER_OWNER = 'outro-dono@example.com';
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
  storeId?: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: session.headers(storeId),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const tokenFrom = (link: string | undefined): string => link?.split('#token=')[1] ?? '';

async function activity(server: TestApp, session: Session, storeId: string) {
  const response = await call(server, 'GET', '/v1/activity-log?limit=100', session, storeId);
  return response.json<{ items: { action: string; details: Record<string, unknown> }[] }>().items;
}

describe('criar loja (POST /v1/stores)', () => {
  it('cria a loja, torna a pessoa proprietária e registra no log', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const response = await call(server, 'POST', '/v1/stores', owner, undefined, {
      name: '  Loja Nova  ',
    });

    expect(response.statusCode).toBe(201);
    const created = response.json<{ id: string; name: string; role: string }>();
    expect(created).toMatchObject({ name: 'Loja Nova', role: 'OWNER' });

    const mine = await call(server, 'GET', '/v1/me/stores', owner);
    expect(mine.json<{ items: { id: string }[] }>().items.map((s) => s.id)).toContain(created.id);
    const log = await activity(server, owner, created.id);
    expect(log.map((entry) => entry.action)).toContain('store.created');
  });

  it('recusa quem não tem a permissão global de criar lojas', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'POST', '/v1/stores', staff, undefined, { name: 'Minha' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'CANNOT_CREATE_STORES' });
  });

  it('recusa acima do limite, contando as lojas de que é proprietário', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    // O dono já é proprietário de 2 lojas e o limite é 3.
    expect(
      (await call(server, 'POST', '/v1/stores', owner, undefined, { name: 'Terceira' })).statusCode,
    ).toBe(201);
    const blocked = await call(server, 'POST', '/v1/stores', owner, undefined, { name: 'Quarta' });

    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'STORE_LIMIT_REACHED' });
  });

  it('criações simultâneas no limite: só uma passa', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const results = await Promise.all(
      ['Corrida 1', 'Corrida 2', 'Corrida 3', 'Corrida 4'].map((name) =>
        call(server, 'POST', '/v1/stores', owner, undefined, { name }),
      ),
    );

    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(3);
    const owned = await world.admin.query(
      "SELECT 1 FROM store_members WHERE user_id = $1 AND role = 'OWNER'",
      [SEED_IDS.userOwner],
    );
    expect(owned.rowCount).toBe(3);
  });

  it('valida o nome e exige login', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    for (const payload of [{}, { name: '   ' }, { name: 'x'.repeat(121) }, { name: null }]) {
      const response = await call(server, 'POST', '/v1/stores', owner, undefined, payload);
      expect(response.statusCode).toBe(400);
    }
    const anonymous = await server.app.inject({
      method: 'POST',
      url: '/v1/stores',
      payload: { name: 'Sem login' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('o administrador da plataforma, sem a permissão global, também é recusado', async () => {
    const server = await start();
    const admin = await login(server, 'admin@example.com');

    const response = await call(server, 'POST', '/v1/stores', admin, undefined, { name: 'Admin' });

    expect(response.statusCode).toBe(403);
  });
});

describe('editar loja (PATCH /v1/store)', () => {
  it('o proprietário edita nome e limite de inatividade e fica no log', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const response = await call(server, 'PATCH', '/v1/store', owner, A, {
      name: ' Zé Cards ',
      inactivity_days_limit: 45,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: A, name: 'Zé Cards', inactivity_days_limit: 45 });
    const entry = (await activity(server, owner, A)).find((e) => e.action === 'store.updated');
    expect(entry?.details).toEqual({ fields: ['name', 'inactivityDaysLimit'] });
  });

  it('null desliga a expulsão por inatividade', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const response = await call(server, 'PATCH', '/v1/store', owner, A, {
      inactivity_days_limit: null,
    });

    expect(response.json()).toMatchObject({ inactivity_days_limit: null });
  });

  it('funcionário não edita a loja', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'PATCH', '/v1/store', staff, A, { name: 'Invadida' });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'OWNER_REQUIRED' });
  });

  it('proprietário de uma loja não edita outra', async () => {
    const server = await start();
    const other = await login(server, OTHER_OWNER);

    const response = await call(server, 'PATCH', '/v1/store', other, A, { name: 'Roubada' });

    expect(response.statusCode).toBe(403);
    const name = await world.admin.query('SELECT name FROM stores WHERE id = $1', [A]);
    expect(name.rows[0]).toEqual({ name: 'Cartas do Zé 🔥' });
  });

  it('valida os campos', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    for (const payload of [
      {},
      { name: '' },
      { inactivity_days_limit: 0 },
      { inactivity_days_limit: 5000 },
      { inactivity_days_limit: 'x' },
    ]) {
      expect((await call(server, 'PATCH', '/v1/store', owner, A, payload)).statusCode).toBe(400);
    }
  });
});

describe('equipe (GET /v1/team)', () => {
  it('qualquer membro lista a equipe com papel e permissões efetivas', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'GET', '/v1/team', staff, A);

    expect(response.statusCode).toBe(200);
    const { items } = response.json<{
      items: { email: string; role: string; permissions: Record<string, boolean> }[];
    }>();
    expect(items.map((m) => m.email).sort((a, b) => a.localeCompare(b))).toEqual([OWNER, STAFF]);
    expect(items.find((m) => m.role === 'OWNER')?.permissions.can_delete).toBe(true);
    expect(items.find((m) => m.role === 'STAFF')?.permissions.can_delete).toBe(false);
  });

  it('não mostra a equipe de outra loja', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const response = await call(server, 'GET', '/v1/team', owner, B);

    expect(response.json<{ items: { email: string }[] }>().items.map((m) => m.email)).toEqual([
      OWNER,
    ]);
    expect((await call(server, 'GET', '/v1/team', owner, C)).statusCode).toBe(403);
  });

  it('pagina por cursor e recusa cursor inválido', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const first = await call(server, 'GET', '/v1/team?limit=1', owner, A);
    const page1 = first.json<{ items: { id: string }[]; next_cursor: string | null }>();
    expect(page1.items).toHaveLength(1);
    expect(page1.next_cursor).not.toBeNull();

    const second = await call(
      server,
      'GET',
      `/v1/team?limit=1&cursor=${page1.next_cursor ?? ''}`,
      owner,
      A,
    );
    const page2 = second.json<{ items: { id: string }[]; next_cursor: string | null }>();
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
    expect(page2.next_cursor).toBeNull();

    expect((await call(server, 'GET', '/v1/team?cursor=lixo', owner, A)).statusCode).toBe(400);
    expect((await call(server, 'GET', '/v1/team?limit=1000', owner, A)).statusCode).toBe(400);
  });
});

describe('convidar funcionário (POST /v1/team/invitations)', () => {
  it('convida, manda o link, aceita e a pessoa entra na equipe; tudo no log', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const response = await call(server, 'POST', '/v1/team/invitations', owner, A, {
      email: 'Nova.Pessoa@Example.com',
      permissions: { can_view_finance: true, inventada: true },
    });
    await server.invitations.flush();

    expect(response.statusCode).toBe(201);
    const token = tokenFrom(server.email.lastInvitationFor('nova.pessoa@example.com')?.link);
    expect(token.length).toBeGreaterThan(20);

    const accepted = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token },
    });
    expect(accepted.statusCode).toBe(200);

    const team = await call(server, 'GET', '/v1/team', owner, A);
    const newcomer = team
      .json<{ items: { email: string; permissions: Record<string, boolean> }[] }>()
      .items.find((m) => m.email === 'nova.pessoa@example.com');
    expect(newcomer?.permissions).toMatchObject({ can_view_finance: true, can_delete: false });
    expect(newcomer?.permissions).not.toHaveProperty('inventada');

    const actions = (await activity(server, owner, A)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['invitation.sent', 'member.joined']));
  });

  it('funcionário não convida', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'POST', '/v1/team/invitations', staff, A, {
      email: 'x@example.com',
    });

    expect(response.statusCode).toBe(403);
  });

  it('responde igual para e-mail com e sem conta (sem enumeração)', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const known = await call(server, 'POST', '/v1/team/invitations', owner, A, {
      email: OTHER_OWNER,
    });
    const unknown = await call(server, 'POST', '/v1/team/invitations', owner, A, {
      email: 'novo@example.com',
    });

    expect(known.statusCode).toBe(201);
    expect(unknown.statusCode).toBe(201);
    expect(Object.keys(known.json())).toEqual(Object.keys(unknown.json()));
  });

  it('recusa quem já é da equipe e conta suspensa', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const member = await call(server, 'POST', '/v1/team/invitations', owner, A, { email: STAFF });
    const suspended = await call(server, 'POST', '/v1/team/invitations', owner, A, {
      email: 'suspenso@example.com',
    });

    expect(member.statusCode).toBe(409);
    expect(member.json()).toMatchObject({ code: 'ALREADY_MEMBER' });
    expect(suspended.statusCode).toBe(422);
    expect(suspended.json()).toMatchObject({ code: 'INVITATION_NOT_ALLOWED' });
  });

  it('valida e-mail e tipo das permissões', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    for (const payload of [
      {},
      { email: 'nao-e-email' },
      { email: 'a@example.com', permissions: { can_delete: 'sim' } },
    ]) {
      expect(
        (await call(server, 'POST', '/v1/team/invitations', owner, A, payload)).statusCode,
      ).toBe(400);
    }
  });
});

describe('permissões e remoção (PATCH e DELETE /v1/team/:id)', () => {
  const staffMemberId = uid(KIND.member, 3);
  const ownerMemberId = uid(KIND.member, 1);

  it('ajusta permissões, vale na hora e registra só as chaves alteradas', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    expect((await call(server, 'GET', '/v1/activity-log', staff, A)).statusCode).toBe(403);

    const response = await call(server, 'PATCH', `/v1/team/${staffMemberId}`, owner, A, {
      permissions: { can_view_finance: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ permissions: Record<string, boolean> }>().permissions).toMatchObject({
      can_view_finance: true,
      can_delete: false,
    });
    const store = await call(server, 'GET', '/v1/store', staff, A);
    expect(
      store.json<{ permissions: Record<string, boolean> }>().permissions.can_view_finance,
    ).toBe(true);
    const entry = (await activity(server, owner, A)).find(
      (e) => e.action === 'member.permissions_updated',
    );
    expect(entry?.details).toEqual({ changed: ['can_view_finance'] });
  });

  it('o proprietário tem todas as permissões e não é ajustável', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const response = await call(server, 'PATCH', `/v1/team/${ownerMemberId}`, owner, A, {
      permissions: { can_delete: false },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'OWNER_PERMISSIONS_FIXED' });
  });

  it('funcionário não ajusta permissão, nem a própria', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'PATCH', `/v1/team/${staffMemberId}`, staff, A, {
      permissions: { can_delete: true },
    });

    expect(response.statusCode).toBe(403);
  });

  it('membro de outra loja responde 404, como se não existisse', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const otherStoreMember = uid(KIND.member, 4);

    expect(
      (await call(server, 'PATCH', `/v1/team/${otherStoreMember}`, owner, A, { permissions: {} }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(server, 'DELETE', `/v1/team/${otherStoreMember}`, owner, A)).statusCode,
    ).toBe(404);
  });

  it('remove o funcionário: o acesso à loja some na hora e fica no log', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    expect((await call(server, 'GET', '/v1/store', staff, A)).statusCode).toBe(200);

    const removed = await call(server, 'DELETE', `/v1/team/${staffMemberId}`, owner, A);

    expect(removed.statusCode).toBe(204);
    expect((await call(server, 'GET', '/v1/store', staff, A)).statusCode).toBe(403);
    expect((await activity(server, owner, A)).map((e) => e.action)).toContain('member.removed');
  });

  it('recusa remover o último proprietário', async () => {
    const server = await start();
    const other = await login(server, OTHER_OWNER);
    const members = await world.admin.query<{ id: string }>(
      'SELECT id FROM store_members WHERE store_id = $1',
      [C],
    );

    const response = await call(
      server,
      'DELETE',
      `/v1/team/${members.rows[0]?.id ?? ''}`,
      other,
      C,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'LAST_OWNER' });
  });

  it('dois proprietários se removendo ao mesmo tempo: a loja nunca fica sem proprietário', async () => {
    const server = await start();
    await world.admin.query("UPDATE store_members SET role = 'OWNER' WHERE id = $1", [
      staffMemberId,
    ]);
    const owner = await login(server, OWNER);
    const second = await login(server, STAFF);

    const results = await Promise.all([
      call(server, 'DELETE', `/v1/team/${staffMemberId}`, owner, A),
      call(server, 'DELETE', `/v1/team/${ownerMemberId}`, second, A),
    ]);

    // Quem perde a corrida leva 409 (último proprietário) ou 403 (já foi removido): nunca 204 duas vezes.
    const codes = results.map((r) => r.statusCode).sort((a, b) => a - b);
    expect(codes[0]).toBe(204);
    expect([403, 409]).toContain(codes[1]);
    expect(
      await server.team.countOwners({ storeId: A, userId: SEED_IDS.userOwner }),
    ).toBeLessThanOrEqual(1);
    const left = await world.admin.query(
      "SELECT 1 FROM store_members WHERE store_id = $1 AND role = 'OWNER'",
      [A],
    );
    expect(left.rowCount).toBe(1);
  });
});

describe('convites da loja (listar, reenviar, revogar)', () => {
  async function invite(server: TestApp, owner: Session, email: string) {
    const response = await call(server, 'POST', '/v1/team/invitations', owner, A, { email });
    await server.invitations.flush();
    return {
      id: response.json<{ id: string }>().id,
      token: tokenFrom(server.email.lastInvitationFor(email)?.link),
    };
  }

  it('lista com estado, inclusive vencido; só para o proprietário', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    await invite(server, owner, 'pendente@example.com');

    const response = await call(server, 'GET', '/v1/team/invitations?limit=100', owner, A);
    const { items } = response.json<{ items: { email: string; state: string }[] }>();

    expect(items.find((i) => i.email === 'pendente@example.com')?.state).toBe('PENDING');
    expect(items.find((i) => i.email === 'expirado@example.com')?.state).toBe('EXPIRED');
    expect(items.find((i) => i.email === 'revogado@example.com')).toBeUndefined();
    expect((await call(server, 'GET', '/v1/team/invitations', staff, A)).statusCode).toBe(403);
  });

  it('revogar derruba o link na hora; revogar de novo ou convite alheio dá 404', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const { id, token } = await invite(server, owner, 'revogar@example.com');

    expect((await call(server, 'DELETE', `/v1/team/invitations/${id}`, owner, A)).statusCode).toBe(
      204,
    );

    const accepted = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token },
    });
    expect(accepted.statusCode).toBe(404);
    expect((await call(server, 'DELETE', `/v1/team/invitations/${id}`, owner, A)).statusCode).toBe(
      404,
    );
    const foreign = uid(KIND.invitation, 3);
    expect(
      (await call(server, 'DELETE', `/v1/team/invitations/${foreign}`, owner, A)).statusCode,
    ).toBe(404);
    expect((await activity(server, owner, A)).map((e) => e.action)).toContain('invitation.revoked');
  });

  it('reenviar gera token novo e o anterior deixa de valer', async () => {
    const server = await start({ INVITATION_RESEND_SECONDS: '0' });
    const owner = await login(server, OWNER);
    const { id, token: oldToken } = await invite(server, owner, 'reenviar@example.com');

    const response = await call(server, 'POST', `/v1/team/invitations/${id}/resend`, owner, A);
    await server.invitations.flush();
    const newToken = tokenFrom(server.email.lastInvitationFor('reenviar@example.com')?.link);

    expect(response.statusCode).toBe(201);
    expect(newToken).not.toBe(oldToken);
    const old = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token: oldToken },
    });
    const fresh = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token: newToken },
    });
    expect(old.statusCode).toBe(404);
    expect(fresh.statusCode).toBe(200);
  });

  it('reenviar cedo demais é recusado (anti-spam)', async () => {
    const server = await start({ INVITATION_RESEND_SECONDS: '60' });
    const owner = await login(server, OWNER);
    const { id } = await invite(server, owner, 'cedo@example.com');

    const response = await call(server, 'POST', `/v1/team/invitations/${id}/resend`, owner, A);

    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'RESEND_TOO_SOON' });
  });

  it('reenviar um convite já usado dá 409', async () => {
    const server = await start({ INVITATION_RESEND_SECONDS: '0' });
    const owner = await login(server, OWNER);
    const { id, token } = await invite(server, owner, 'usado@example.com');
    await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token },
    });

    const response = await call(server, 'POST', `/v1/team/invitations/${id}/resend`, owner, A);

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'INVITATION_NOT_PENDING' });
  });
});

describe('log de atividades (GET /v1/activity-log)', () => {
  it('só o proprietário lê, do mais novo para o mais antigo, sem dado pessoal', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    await call(server, 'PATCH', '/v1/store', owner, A, { name: 'Novo Nome' });
    await call(server, 'POST', '/v1/team/invitations', owner, A, { email: 'privado@example.com' });

    const denied = await call(server, 'GET', '/v1/activity-log', staff, A);
    const response = await call(server, 'GET', '/v1/activity-log?limit=100', owner, A);

    expect(denied.statusCode).toBe(403);
    expect(response.statusCode).toBe(200);
    const { items } = response.json<{
      items: { created_at: string; action: string; actor: { email: string } | null }[];
    }>();
    const dates = items.map((item) => Date.parse(item.created_at));
    expect([...dates].sort((a, b) => b - a)).toEqual(dates);
    expect(items.map((item) => item.action)).toEqual(
      expect.arrayContaining(['store.updated', 'invitation.sent']),
    );
    expect(response.body).not.toContain('privado@example.com');
    // o único e-mail na resposta é o de quem agiu (campo `actor`, só de quem ainda é da equipe)
    const withoutActor = items.map((item) => ({ ...item, actor: undefined }));
    expect(JSON.stringify(withoutActor)).not.toContain('@');
    expect(items.every((item) => item.actor === null || item.actor.email === OWNER)).toBe(true);
  });

  it('não mostra o log de outra loja', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const logB = (await activity(server, owner, B)).map((e) => e.action);
    const logA = (await activity(server, owner, A)).map((e) => e.action);

    expect(logB).toEqual(['store.updated']);
    expect(logA).not.toContain('store.updated');
  });

  it('pagina por cursor', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const first = await call(server, 'GET', '/v1/activity-log?limit=1', owner, A);
    const page = first.json<{ items: unknown[]; next_cursor: string | null }>();
    const second = await call(
      server,
      'GET',
      `/v1/activity-log?limit=1&cursor=${page.next_cursor ?? ''}`,
      owner,
      A,
    );

    expect(page.items).toHaveLength(1);
    expect(page.next_cursor).not.toBeNull();
    expect(second.json<{ items: unknown[] }>().items).toHaveLength(1);
    expect((await call(server, 'GET', '/v1/activity-log?cursor=%%%', owner, A)).statusCode).toBe(
      400,
    );
  });
});

describe('log de atividades no banco (RLS e imutabilidade)', () => {
  const count = async (userId: string, storeId: string, extra?: { admin?: boolean }) => {
    const server = app ?? (await start());
    const { withContext } = await import('../src/db/context.js');
    const { sql } = await import('drizzle-orm');
    return withContext(
      server.db,
      { userId, storeId, ...(extra?.admin === true ? { isPlatformAdmin: true } : {}) },
      async (tx) => {
        const result = await tx.execute<{ n: string }>(sql`SELECT count(*) AS n FROM activity_log`);
        return Number(result.rows[0]?.n);
      },
    );
  };

  it('o proprietário lê; o funcionário, o administrador e quem não é da loja não leem', async () => {
    expect(await count(SEED_IDS.userOwner, A)).toBeGreaterThan(0);
    expect(await count(SEED_IDS.userStaff, A)).toBe(0);
    expect(await count(SEED_IDS.userAdmin, A, { admin: true })).toBe(0);
    expect(await count(SEED_IDS.userOtherOwner, A)).toBe(0);
  });

  it('a aplicação não consegue alterar nem apagar registros', async () => {
    const server = await start();
    const { withContext } = await import('../src/db/context.js');
    const { sql } = await import('drizzle-orm');

    await expect(
      withContext(server.db, { userId: SEED_IDS.userOwner, storeId: A }, (tx) =>
        tx.execute(sql`UPDATE activity_log SET action = 'x.y'`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(
      withContext(server.db, { userId: SEED_IDS.userOwner, storeId: A }, (tx) =>
        tx.execute(sql`DELETE FROM activity_log`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('não grava registro em nome de outra loja', async () => {
    const server = await start();
    const { withContext } = await import('../src/db/context.js');
    const { sql } = await import('drizzle-orm');

    await expect(
      withContext(server.db, { userId: SEED_IDS.userOwner, storeId: A }, (tx) =>
        tx.execute(sql`INSERT INTO activity_log (store_id, action) VALUES (${B}, 'store.fake')`),
      ),
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});
