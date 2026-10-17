import type pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthHooks } from '../src/auth/hooks.js';
import { signAccessToken } from '../src/auth/jwt.js';
import { createPool } from '../src/db/client.js';
import { migrateUp } from '../src/db/migrator.js';
import { provisionLoginRole } from '../src/db/roles.js';
import { SEED_IDS, seedDatabase } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { resetDatabase, startDatabase, type TestDatabase } from './helpers/database.js';

/**
 * Fluxo completo contra Postgres real, conectando com o papel `app_api` (sem
 * BYPASSRLS). O pool de superusuário só serve para preparar e conferir o banco.
 */

let database: TestDatabase;
let appPool: pg.Pool;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const ADMIN = 'admin@example.com';

beforeAll(async () => {
  database = await startDatabase();
  await resetDatabase(database.pool);
  await migrateUp(database.pool, 'migrations');
  await provisionLoginRole(database.pool, { name: 'app_api', password: 'senha-de-teste' });
  const url = new URL(database.uri);
  url.username = 'app_api';
  url.password = 'senha-de-teste';
  appPool = createPool(url.toString());
});

afterAll(async () => {
  await appPool.end();
  await database.stop();
});

beforeEach(async () => {
  await seedDatabase(database.pool);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(env: NodeJS.ProcessEnv = {}, now?: () => Date): Promise<TestApp> {
  app = await buildTestApp({ pool: appPool, env, ...(now === undefined ? {} : { now }) });
  return app;
}

interface LoggedIn {
  accessToken: string;
  refreshCookie: string;
}

async function requestCode(server: TestApp, email: string): Promise<string> {
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/request',
    payload: { email },
  });
  expect(response.statusCode).toBe(202);
  await server.auth.flush();
  const message = server.email.lastOtpFor(email.trim().toLowerCase());
  if (message === undefined) throw new Error(`nenhum código enviado para ${email}`);
  return message.code;
}

async function login(server: TestApp, email: string): Promise<LoggedIn> {
  const code = await requestCode(server, email);
  const response = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { email, code },
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.find((item) => item.name === 'refresh_token');
  if (cookie === undefined) throw new Error('sem cookie de refresh');
  return {
    accessToken: response.json<{ access_token: string }>().access_token,
    refreshCookie: cookie.value,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function userRow(email: string) {
  const result = await database.pool.query<{
    otp_hash: string | null;
    otp_attempts: number;
    last_login_at: Date | null;
    status: string;
  }>('SELECT otp_hash, otp_attempts, last_login_at, status FROM users WHERE email = $1', [email]);
  return result.rows[0];
}

describe('pedido de código (acesso só por convite)', () => {
  it('envia um código de 6 dígitos e guarda só o hash', async () => {
    const server = await start();

    const code = await requestCode(server, OWNER);

    expect(code).toMatch(/^\d{6}$/);
    const row = await userRow(OWNER);
    expect(row?.otp_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.otp_hash).not.toContain(code);
  });

  it('não envia nada e não cria usuário para e-mail sem conta', async () => {
    const server = await start();

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: 'desconhecido@example.com' },
    });
    await server.auth.flush();

    expect(response.statusCode).toBe(202);
    expect(server.email.otps).toHaveLength(0);
    expect(await userRow('desconhecido@example.com')).toBeUndefined();
  });

  it.each(['convidado@example.com', 'suspenso@example.com'])(
    'não envia código para conta %s (convidada ainda não aceitou; suspensa não entra)',
    async (email) => {
      const server = await start();

      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { email },
      });
      await server.auth.flush();

      expect(response.statusCode).toBe(202);
      expect(server.email.otps).toHaveLength(0);
    },
  );

  it('responde igual com e sem conta (sem enumeração de e-mail)', async () => {
    const server = await start();
    const send = (email: string) =>
      server.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { email } });

    const known = await send(OWNER);
    const unknown = await send('nao-existe@example.com');

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(known.body).toBe(unknown.body);
  });

  it('aceita e-mail com maiúsculas (o formato com espaços é recusado pela validação)', async () => {
    const server = await start();

    const code = await requestCode(server, 'Dono@Example.COM');

    expect(code).toMatch(/^\d{6}$/);
  });

  it('respeita o intervalo mínimo entre pedidos', async () => {
    const server = await start({ OTP_RESEND_SECONDS: '60' });

    await requestCode(server, OWNER);
    await server.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: OWNER },
    });
    await server.auth.flush();

    expect(server.email.otps).toHaveLength(1);
  });

  it('rejeita e-mail malformado com erro de validação', async () => {
    const server = await start();

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/request',
      payload: { email: 'isto-nao-e-email' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('verificação do código', () => {
  it('abre a sessão, grava o refresh em cookie seguro e registra o login', async () => {
    const server = await start();
    const code = await requestCode(server, OWNER);

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { email: OWNER, code },
      headers: { 'user-agent': 'Vitest/1.0' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      token_type: 'Bearer',
      expires_in: 900,
      user: { email: OWNER, name: 'Dono Demo' },
    });
    const cookie = response.cookies.find((item) => item.name === 'refresh_token');
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/v1/auth' });
    expect(cookie?.value.length).toBeGreaterThanOrEqual(40);
    const row = await userRow(OWNER);
    expect(row?.last_login_at).not.toBeNull();
    expect(row?.otp_hash).toBeNull();
    const sessions = await database.pool.query<{ user_agent: string }>(
      'SELECT user_agent FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL',
      [SEED_IDS.userOwner],
    );
    expect(sessions.rows.map((r) => r.user_agent)).toContain('Vitest/1.0');
  });

  it('só guarda o hash do refresh token', async () => {
    const server = await start();
    const { refreshCookie } = await login(server, OWNER);

    const stored = await database.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM refresh_tokens WHERE token_hash = $1',
      [refreshCookie],
    );

    expect(stored.rowCount).toBe(0);
  });

  it('o código vale uma vez só', async () => {
    const server = await start();
    const code = await requestCode(server, OWNER);
    const verify = () =>
      server.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { email: OWNER, code },
      });

    expect((await verify()).statusCode).toBe(200);
    expect((await verify()).statusCode).toBe(401);
  });

  it('código errado: 401 genérico, e conta a tentativa', async () => {
    const server = await start();
    await requestCode(server, OWNER);

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { email: OWNER, code: '000000' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'INVALID_CODE' });
    expect((await userRow(OWNER))?.otp_attempts).toBe(1);
  });

  it('esgotadas as tentativas, nem o código certo funciona até pedir outro', async () => {
    const server = await start({ OTP_MAX_ATTEMPTS: '3' });
    const code = await requestCode(server, OWNER);
    const wrong = code === '111111' ? '222222' : '111111';
    const verify = (value: string) =>
      server.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { email: OWNER, code: value },
      });

    for (let i = 0; i < 3; i += 1) expect((await verify(wrong)).statusCode).toBe(401);
    expect((await verify(code)).statusCode).toBe(401);

    const fresh = await requestCode(server, OWNER);
    expect((await verify(fresh)).statusCode).toBe(200);
  });

  it('código vencido não vale', async () => {
    let offset = 0;
    const server = await start({}, () => new Date(Date.now() + offset));
    const code = await requestCode(server, OWNER);
    offset = 11 * 60 * 1000;

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { email: OWNER, code },
    });

    expect(response.statusCode).toBe(401);
  });

  it('erro idêntico para conta inexistente, convidada, suspensa e código errado', async () => {
    const server = await start();
    await requestCode(server, OWNER);
    const attempt = async (email: string) => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { email, code: '123456' },
      });
      return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
    };

    const results = await Promise.all(
      [OWNER, 'nao-existe@example.com', 'convidado@example.com', 'suspenso@example.com'].map(
        attempt,
      ),
    );

    for (const result of results) {
      expect(result.status).toBe(401);
      expect({ ...result.body, instance: undefined }).toEqual({
        ...results[0]?.body,
        instance: undefined,
      });
    }
  });

  it('conta suspensa não entra nem com um código antigo válido', async () => {
    const server = await start();
    const code = await requestCode(server, OWNER);
    await database.pool.query("UPDATE users SET status = 'SUSPENDED' WHERE email = $1", [OWNER]);

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/otp/verify',
      payload: { email: OWNER, code },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('access token', () => {
  it('sem token, token lixo, assinatura alheia e algoritmo none: 401', async () => {
    const server = await start();
    const other = await signAccessToken(
      { ...server.env.auth, accessSecret: 'outro-segredo-0123456789abcdef012345' },
      SEED_IDS.userOwner,
    );
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({
        sub: SEED_IDS.userOwner,
        iss: 'pokemon-auction',
        aud: 'pokemon-auction-api',
      }),
    ).toString('base64url')}.`;

    for (const header of [undefined, 'Bearer lixo', `Bearer ${other.token}`, `Bearer ${none}`]) {
      const response = await server.app.inject({
        method: 'GET',
        url: '/v1/me',
        ...(header === undefined ? {} : { headers: { authorization: header } }),
      });
      expect(response.statusCode).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.json()).toMatchObject({ code: 'UNAUTHENTICATED' });
    }
  });

  it('token vencido: 401', async () => {
    const server = await start();
    const old = await signAccessToken(
      server.env.auth,
      SEED_IDS.userOwner,
      new Date(Date.now() - 60 * 60 * 1000),
    );

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(old.token),
    });

    expect(response.statusCode).toBe(401);
  });

  it('conta suspensa perde o acesso na hora, sem esperar o token vencer', async () => {
    const server = await start();
    const { accessToken } = await login(server, OWNER);
    expect(
      (await server.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(accessToken) }))
        .statusCode,
    ).toBe(200);

    await database.pool.query("UPDATE users SET status = 'SUSPENDED' WHERE email = $1", [OWNER]);

    expect(
      (await server.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(accessToken) }))
        .statusCode,
    ).toBe(401);
  });

  it('GET /v1/me devolve o perfil e as permissões globais', async () => {
    const server = await start();
    const { accessToken } = await login(server, OWNER);

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: bearer(accessToken),
    });

    expect(response.json()).toMatchObject({
      email: OWNER,
      is_platform_admin: false,
      can_create_stores: true,
      store_limit: 3,
    });
  });
});

describe('refresh token', () => {
  const refresh = (server: TestApp, cookie: string) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      cookies: { refresh_token: cookie },
    });

  it('troca por um novo (rotação) e o antigo deixa de valer', async () => {
    const server = await start();
    const first = await login(server, OWNER);

    const second = await refresh(server, first.refreshCookie);
    const rotated = second.cookies.find((item) => item.name === 'refresh_token')?.value;

    expect(second.statusCode).toBe(200);
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(first.refreshCookie);
  });

  it('reuso de um token já trocado revoga todas as sessões', async () => {
    const server = await start();
    const first = await login(server, OWNER);
    const second = await refresh(server, first.refreshCookie);
    const rotated = second.cookies.find((item) => item.name === 'refresh_token')?.value ?? '';

    const reuse = await refresh(server, first.refreshCookie);

    expect(reuse.statusCode).toBe(401);
    // O token novo também morreu: suspeita de roubo derruba a família inteira.
    expect((await refresh(server, rotated)).statusCode).toBe(401);
  });

  it('sem cookie ou com cookie inventado: 401 e cookie limpo', async () => {
    const server = await start();

    const none = await server.app.inject({ method: 'POST', url: '/v1/auth/refresh' });
    const fake = await refresh(server, 'inventado-0123456789012345678901234567890123456789');

    expect(none.statusCode).toBe(401);
    expect(fake.statusCode).toBe(401);
    expect(fake.json()).toMatchObject({ code: 'INVALID_REFRESH' });
  });

  it('refresh de conta suspensa é recusado', async () => {
    const server = await start();
    const { refreshCookie } = await login(server, OWNER);
    await database.pool.query("UPDATE users SET status = 'SUSPENDED' WHERE email = $1", [OWNER]);

    expect((await refresh(server, refreshCookie)).statusCode).toBe(401);
  });

  it('logout encerra a sessão e limpa o cookie', async () => {
    const server = await start();
    const { refreshCookie } = await login(server, OWNER);

    const out = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      cookies: { refresh_token: refreshCookie },
    });

    expect(out.statusCode).toBe(204);
    expect((await refresh(server, refreshCookie)).statusCode).toBe(401);
  });
});

describe('sessões ativas (perfil)', () => {
  it('lista as sessões marcando a atual, e revoga só as próprias', async () => {
    const server = await start();
    const mine = await login(server, OWNER);
    await login(server, OWNER);
    const theirs = await login(server, STAFF);

    const list = await server.app.inject({
      method: 'GET',
      url: '/v1/me/sessions',
      headers: bearer(mine.accessToken),
      cookies: { refresh_token: mine.refreshCookie },
    });
    const items = list.json<{ items: { id: string; current: boolean }[] }>().items;

    // O seed já deixa uma sessão ativa do dono, mais as duas deste teste.
    expect(items).toHaveLength(3);
    expect(items.filter((item) => item.current)).toHaveLength(1);

    const other = items.find((item) => !item.current);
    const revoke = await server.app.inject({
      method: 'DELETE',
      url: `/v1/me/sessions/${other?.id ?? ''}`,
      headers: bearer(mine.accessToken),
    });
    expect(revoke.statusCode).toBe(204);

    const staffSessions = await database.pool.query<{ id: string }>(
      'SELECT id FROM refresh_tokens WHERE user_id = $1',
      [SEED_IDS.userStaff],
    );
    const foreign = await server.app.inject({
      method: 'DELETE',
      url: `/v1/me/sessions/${staffSessions.rows[0]?.id ?? ''}`,
      headers: bearer(mine.accessToken),
    });
    expect(foreign.statusCode).toBe(404);
    expect(theirs.accessToken).toBeDefined();
  });
});

describe('lojas e isolamento por x-store-id', () => {
  const storeId = (name: 'A' | 'B' | 'C') =>
    ({ A: SEED_IDS.storeA, B: SEED_IDS.storeB, C: SEED_IDS.storeC })[name];

  const getStore = (server: TestApp, token: string, header?: string) =>
    server.app.inject({
      method: 'GET',
      url: '/v1/store',
      headers: { ...bearer(token), ...(header === undefined ? {} : { 'x-store-id': header }) },
    });

  it('lista só as lojas de que a pessoa participa', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);

    const list = async (token: string) =>
      (
        await server.app.inject({
          method: 'GET',
          url: '/v1/me/stores',
          headers: bearer(token),
        })
      ).json<{ items: { id: string; role: string }[] }>().items;

    expect(
      (await list(owner.accessToken)).map((s) => s.id).sort((a, b) => a.localeCompare(b)),
    ).toEqual([SEED_IDS.storeA, SEED_IDS.storeB].sort((a, b) => a.localeCompare(b)));
    expect(await list(staff.accessToken)).toEqual([
      expect.objectContaining({ id: SEED_IDS.storeA, role: 'STAFF' }),
    ]);
  });

  it('membro com x-store-id válido vê a loja, o papel e as permissões efetivas', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);

    const asOwner = await getStore(server, owner.accessToken, storeId('A'));
    const asStaff = await getStore(server, staff.accessToken, storeId('A'));

    expect(asOwner.json()).toMatchObject({ id: storeId('A'), role: 'OWNER' });
    expect(asOwner.json<{ permissions: Record<string, boolean> }>().permissions).toMatchObject({
      can_delete: true,
      can_view_finance: true,
    });
    expect(asStaff.json()).toMatchObject({ role: 'STAFF' });
    expect(asStaff.json<{ permissions: Record<string, boolean> }>().permissions).toMatchObject({
      can_delete: false,
      can_view_finance: false,
      can_manage_auctions: true,
    });
  });

  it('sem header, malformado ou de loja alheia: a mesma resposta 403', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const bodies: unknown[] = [];

    for (const header of [undefined, 'nao-e-uuid', storeId('B'), storeId('C')]) {
      const response = await getStore(server, staff.accessToken, header);
      expect(response.statusCode).toBe(403);
      bodies.push({ ...response.json<object>(), instance: undefined });
    }

    expect(new Set(bodies.map((body) => JSON.stringify(body))).size).toBe(1);
  });

  it('o administrador da plataforma não é membro: não entra numa loja', async () => {
    const server = await start();
    const admin = await login(server, ADMIN);

    expect((await getStore(server, admin.accessToken, storeId('A'))).statusCode).toBe(403);
    expect(
      (
        await server.app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: bearer(admin.accessToken),
        })
      ).json(),
    ).toMatchObject({ is_platform_admin: true });
  });

  it('sem login, a loja responde 401 antes de qualquer outro erro', async () => {
    const server = await start();

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/store',
      headers: { 'x-store-id': 'lixo' },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('RBAC nos hooks', () => {
  async function startWithGuardedRoutes() {
    app = await buildTestApp({ pool: appPool, ready: false });
    const hooks = createAuthHooks({ db: app.db, config: app.env.auth });
    const base = [hooks.authenticate, hooks.requireStore];
    app.app.get(
      '/test/finance',
      { preValidation: [...base, hooks.requirePermission('can_view_finance')] },
      () => ({ ok: true }),
    );
    app.app.get('/test/owner', { preValidation: [...base, hooks.requireOwner] }, () => ({
      ok: true,
    }));
    app.app.get(
      '/test/admin',
      { preValidation: [hooks.authenticate, hooks.requirePlatformAdmin] },
      () => ({ ok: true }),
    );
    await app.app.ready();
    return app;
  }

  const call = (server: TestApp, url: string, token: string, store?: string) =>
    server.app.inject({
      method: 'GET',
      url,
      headers: { ...bearer(token), ...(store === undefined ? {} : { 'x-store-id': store }) },
    });

  it('permissão negada: 403 MISSING_PERMISSION; proprietário passa', async () => {
    const server = await startWithGuardedRoutes();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);

    const denied = await call(server, '/test/finance', staff.accessToken, SEED_IDS.storeA);
    const allowed = await call(server, '/test/finance', owner.accessToken, SEED_IDS.storeA);

    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'MISSING_PERMISSION' });
    expect(allowed.statusCode).toBe(200);
  });

  it('a permissão ajustada no banco vale na hora, só para aquele funcionário', async () => {
    const server = await startWithGuardedRoutes();
    const staff = await login(server, STAFF);
    await database.pool.query(
      `UPDATE store_members SET permissions = '{"can_view_finance": true}'
        WHERE user_id = $1 AND store_id = $2`,
      [SEED_IDS.userStaff, SEED_IDS.storeA],
    );

    const response = await call(server, '/test/finance', staff.accessToken, SEED_IDS.storeA);

    expect(response.statusCode).toBe(200);
  });

  it('só o proprietário passa em rota de proprietário', async () => {
    const server = await startWithGuardedRoutes();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);

    expect(
      (await call(server, '/test/owner', staff.accessToken, SEED_IDS.storeA)).json(),
    ).toMatchObject({
      code: 'OWNER_REQUIRED',
    });
    expect((await call(server, '/test/owner', owner.accessToken, SEED_IDS.storeA)).statusCode).toBe(
      200,
    );
  });

  it('só o administrador da plataforma passa na rota de administração', async () => {
    const server = await startWithGuardedRoutes();
    const owner = await login(server, OWNER);
    const admin = await login(server, ADMIN);

    expect((await call(server, '/test/admin', owner.accessToken)).statusCode).toBe(403);
    expect((await call(server, '/test/admin', admin.accessToken)).statusCode).toBe(200);
  });
});

describe('convites', () => {
  const create = (server: TestApp, input: Parameters<TestApp['invitations']['create']>[0]) =>
    server.invitations.create(input);
  const tokenFrom = (link: string): string => link.split('#token=')[1] ?? '';

  async function inviteStaff(server: TestApp, email: string) {
    const result = await create(server, {
      email,
      storeId: SEED_IDS.storeA,
      role: 'STAFF',
      permissions: { can_view_finance: true, ignorada: true },
      invitedBy: SEED_IDS.userOwner,
    });
    await server.invitations.flush();
    const message = server.email.lastInvitationFor(email.toLowerCase());
    return { result, token: tokenFrom(message?.link ?? ''), message };
  }

  it('cria a conta como convidada, manda o link com o token no fragmento e guarda só o hash', async () => {
    const server = await start();

    const { result, token, message } = await inviteStaff(server, 'Novo@Example.com');

    expect(result.ok).toBe(true);
    expect(message?.link).toContain('/convite#token=');
    expect(message).toMatchObject({
      to: 'novo@example.com',
      storeName: 'Cartas do Zé 🔥',
      role: 'STAFF',
    });
    expect((await userRow('novo@example.com'))?.status).toBe('INVITED');
    const stored = await database.pool.query('SELECT 1 FROM invitations WHERE token_hash = $1', [
      token,
    ]);
    expect(stored.rowCount).toBe(0);
  });

  it('mostra o que o convite concede, sem aceitá-lo', async () => {
    const server = await start();
    const { token } = await inviteStaff(server, 'novo@example.com');

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/preview',
      payload: { token },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      email: 'novo@example.com',
      store_name: 'Cartas do Zé 🔥',
      role: 'STAFF',
      permissions: { can_view_finance: true, can_delete: false },
    });
    expect((await userRow('novo@example.com'))?.status).toBe('INVITED');
  });

  it('aceitar ativa a conta, cria a associação e libera o login por código', async () => {
    const server = await start();
    const { token } = await inviteStaff(server, 'novo@example.com');

    const accepted = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token },
    });
    const logged = await login(server, 'novo@example.com');

    expect(accepted.statusCode).toBe(200);
    expect((await userRow('novo@example.com'))?.status).toBe('ACTIVE');
    const store = await server.app.inject({
      method: 'GET',
      url: '/v1/store',
      headers: { ...bearer(logged.accessToken), 'x-store-id': SEED_IDS.storeA },
    });
    expect(store.json()).toMatchObject({ role: 'STAFF' });
    // Só a chave conhecida entrou: "ignorada" foi descartada.
    expect(store.json<{ permissions: Record<string, boolean> }>().permissions).not.toHaveProperty(
      'ignorada',
    );
  });

  it('convite usado, revogado, vencido ou inventado: o mesmo 404', async () => {
    let offset = 0;
    const server = await start({}, () => new Date(Date.now() + offset));
    const used = await inviteStaff(server, 'usado@example.com');
    await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token: used.token },
    });
    const revoked = await inviteStaff(server, 'revogado2@example.com');
    await database.pool.query(
      "UPDATE invitations SET status = 'REVOKED' WHERE email = 'revogado2@example.com'",
    );
    const expired = await inviteStaff(server, 'vencido@example.com');
    offset = 8 * 24 * 60 * 60 * 1000;

    const bodies = await Promise.all(
      [used.token, revoked.token, expired.token, 'x'.repeat(43)].map(async (token) => {
        const response = await server.app.inject({
          method: 'POST',
          url: '/v1/auth/invitations/accept',
          payload: { token },
        });
        expect(response.statusCode).toBe(404);
        return JSON.stringify({ ...response.json<object>(), instance: undefined });
      }),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  it('um convite novo para a mesma pessoa e loja revoga o anterior', async () => {
    const server = await start();
    const first = await inviteStaff(server, 'novo@example.com');
    await inviteStaff(server, 'novo@example.com');

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token: first.token },
    });

    expect(response.statusCode).toBe(404);
  });

  it('não convida conta suspensa', async () => {
    const server = await start();

    const result = await create(server, {
      email: 'suspenso@example.com',
      storeId: SEED_IDS.storeA,
      role: 'STAFF',
      invitedBy: SEED_IDS.userOwner,
    });

    expect(result).toEqual({ ok: false, reason: 'USER_SUSPENDED' });
  });

  it('convite com loja exige papel (e vice-versa)', async () => {
    const server = await start();

    expect(
      await create(server, { email: 'x@example.com', storeId: SEED_IDS.storeA, invitedBy: null }),
    ).toEqual({ ok: false, reason: 'ROLE_REQUIRED' });
    expect(
      await create(server, { email: 'y@example.com', role: 'STAFF', invitedBy: null }),
    ).toEqual({
      ok: false,
      reason: 'ROLE_REQUIRED',
    });
  });

  it('conta já ativa aceita convite para outra loja sem perder o que tem', async () => {
    const server = await start();
    const result = await create(server, {
      email: STAFF,
      storeId: SEED_IDS.storeB,
      role: 'STAFF',
      invitedBy: SEED_IDS.userOwner,
    });
    await server.invitations.flush();
    const token = tokenFrom(server.email.lastInvitationFor(STAFF)?.link ?? '');

    await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token },
    });
    const staff = await login(server, STAFF);
    const list = await server.app.inject({
      method: 'GET',
      url: '/v1/me/stores',
      headers: bearer(staff.accessToken),
    });

    expect(result.ok).toBe(true);
    expect(list.json<{ items: unknown[] }>().items).toHaveLength(2);
  });

  it('convite só de conta (sem loja) ativa o usuário sem criar associação', async () => {
    const server = await start();
    await create(server, { email: 'lojista@example.com', invitedBy: SEED_IDS.userAdmin });
    await server.invitations.flush();
    const token = tokenFrom(server.email.lastInvitationFor('lojista@example.com')?.link ?? '');

    await server.app.inject({
      method: 'POST',
      url: '/v1/auth/invitations/accept',
      payload: { token },
    });

    expect((await userRow('lojista@example.com'))?.status).toBe('ACTIVE');
    const members = await database.pool.query(
      "SELECT 1 FROM store_members m JOIN users u ON u.id = m.user_id WHERE u.email = 'lojista@example.com'",
    );
    expect(members.rowCount).toBe(0);
  });
});

describe('limite de requisições', () => {
  it('bloqueia o excesso no pedido de código com 429 em problem+json', async () => {
    const server = await start({ RATE_LIMIT_OTP_REQUEST_PER_MINUTE: '2' });
    const send = () =>
      server.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/request',
        payload: { email: OWNER },
      });

    expect((await send()).statusCode).toBe(202);
    expect((await send()).statusCode).toBe(202);
    const blocked = await send();

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['content-type']).toContain('application/problem+json');
    expect(blocked.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('o limite da verificação freia força bruta do código', async () => {
    const server = await start({ RATE_LIMIT_OTP_VERIFY_PER_MINUTE: '3' });
    await requestCode(server, OWNER);
    const guess = () =>
      server.app.inject({
        method: 'POST',
        url: '/v1/auth/otp/verify',
        payload: { email: OWNER, code: '000000' },
      });

    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await guess()).statusCode);

    expect(statuses).toEqual([401, 401, 401, 429, 429]);
  });
});

describe('o hash do OTP depende do e-mail e do segredo', () => {
  it('o mesmo código gera hashes diferentes em contas diferentes', async () => {
    const server = await start();
    await requestCode(server, OWNER);
    await requestCode(server, STAFF);

    const rows = await database.pool.query<{ otp_hash: string }>(
      'SELECT otp_hash FROM users WHERE email IN ($1, $2)',
      [OWNER, STAFF],
    );

    expect(new Set(rows.rows.map((row) => row.otp_hash)).size).toBe(2);
  });
});
