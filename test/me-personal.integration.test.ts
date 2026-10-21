import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SEED_IDS } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { openCpf } from './helpers/cpf.js';
import { startWorld, type World } from './helpers/world.js';

/** GET/PATCH /v1/me (dados pessoais, CPF cifrado) e DELETE /v1/me/sessions. Postgres real. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const ADMIN = 'admin@example.com';
const CPF = '529.982.247-25';

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

interface LoggedIn {
  token: string;
  refresh: string;
}

async function login(server: TestApp, email: string): Promise<LoggedIn> {
  await server.app.inject({ method: 'POST', url: '/v1/auth/otp/request', payload: { email } });
  await server.auth.flush();
  const code = server.email.lastOtpFor(email)?.code;
  const verified = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { email, code },
  });
  expect(verified.statusCode).toBe(200);
  const cookie = verified.cookies.find((item) => item.name === 'refresh_token');
  return {
    token: verified.json<{ access_token: string }>().access_token,
    refresh: cookie?.value ?? '',
  };
}

const call = (
  server: TestApp,
  method: 'GET' | 'PATCH' | 'DELETE',
  url: string,
  who: LoggedIn,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${who.token}` },
    cookies: { refresh_token: who.refresh },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

interface MeJson {
  email: string;
  name: string | null;
  phone: string | null;
  birth_date: string | null;
  cpf_masked: string | null;
  is_platform_admin: boolean;
  address: Record<string, string | null>;
}

const row = async (email: string) =>
  (
    await world.admin.query<Record<string, string | null>>(
      `SELECT name, phone, birth_date::text AS birth_date, cpf, cpf_last2, address_zip, address_street,
              address_neighborhood, address_state, is_platform_admin::text AS is_platform_admin
         FROM users WHERE email = $1`,
      [email],
    )
  ).rows[0];

describe('dados pessoais (GET e PATCH /v1/me)', () => {
  it('começa sem dados pessoais e devolve tudo nulo', async () => {
    const server = await start();
    const me = (await call(server, 'GET', '/v1/me', await login(server, STAFF))).json<MeJson>();

    expect(me).toMatchObject({ phone: null, birth_date: null, cpf_masked: null });
    expect(me.address).toEqual({
      zip: null,
      street: null,
      number: null,
      comp: null,
      neighborhood: null,
      city: null,
      state: null,
    });
  });

  it('grava nome, telefone, nascimento, CPF cifrado e endereço; o CPF nunca volta inteiro', async () => {
    const server = await start();
    const who = await login(server, STAFF);

    const response = await call(server, 'PATCH', '/v1/me', who, {
      name: '  Maria da Silva ',
      phone: '(11) 98888-7777',
      birth_date: '1990-05-17',
      cpf: CPF,
      address: {
        zip: '01310-100',
        street: 'Avenida Paulista',
        number: '1000',
        neighborhood: 'Bela Vista',
        city: 'São Paulo',
        state: 'sp',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const me = response.json<MeJson>();
    expect(me).toMatchObject({
      email: STAFF,
      name: 'Maria da Silva',
      phone: '5511988887777',
      birth_date: '1990-05-17',
      cpf_masked: '•••.•••.•••-25',
    });
    expect(me.address).toMatchObject({ zip: '01310100', state: 'SP', neighborhood: 'Bela Vista' });
    for (const body of [
      response.body,
      (await call(server, 'GET', '/v1/me', who)).body,
      (await call(server, 'GET', '/v1/me/sessions', who)).body,
    ]) {
      expect(body).not.toContain('52998224725');
      expect(body).not.toContain('529.982.247');
    }

    // no banco o CPF é o texto cifrado, que só a chave abre
    const stored = await row(STAFF);
    expect(stored?.['cpf']).toMatch(/^v1\./);
    expect(stored?.['cpf']).not.toContain('52998224725');
    expect(openCpf(stored?.['cpf'])).toBe('52998224725');
    expect(stored?.['cpf_last2']).toBe('25');
    expect(stored?.['phone']).toBe('5511988887777');
  });

  it('mescla o endereço, limpa com null e troca o CPF sem acumular lixo', async () => {
    const server = await start();
    const who = await login(server, STAFF);
    await call(server, 'PATCH', '/v1/me', who, {
      cpf: CPF,
      address: { zip: '01310100', street: 'Rua A', city: 'Santos', state: 'SP' },
    });

    const merged = await call(server, 'PATCH', '/v1/me', who, {
      address: { street: 'Rua B', city: null },
    });
    expect(merged.json<MeJson>().address).toMatchObject({
      zip: '01310100',
      street: 'Rua B',
      city: null,
      state: 'SP',
    });
    expect(merged.json<MeJson>().cpf_masked).toBe('•••.•••.•••-25');

    const cleared = await call(server, 'PATCH', '/v1/me', who, { cpf: null, phone: null });
    expect(cleared.json<MeJson>()).toMatchObject({ cpf_masked: null, phone: null });
    const stored = await row(STAFF);
    expect(stored?.['cpf']).toBeNull();
    expect(stored?.['cpf_last2']).toBeNull();
  });

  it('valida telefone, CPF, CEP, data e corpo no servidor, sem gravar nada', async () => {
    const server = await start();
    const who = await login(server, STAFF);
    const cases: [Record<string, unknown>, string][] = [
      [{ phone: '123' }, 'PROFILE_PHONE_INVALID'],
      [{ cpf: '111.111.111-11' }, 'PROFILE_CPF_INVALID'],
      [{ address: { zip: '123' } }, 'PROFILE_CEP_INVALID'],
      [{ birth_date: '1850-01-01' }, 'PROFILE_BIRTH_DATE_INVALID'],
      [{ birth_date: '2999-01-01' }, 'PROFILE_BIRTH_DATE_INVALID'],
    ];
    for (const [payload, code] of cases) {
      const response = await call(server, 'PATCH', '/v1/me', who, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(422);
      expect(response.json()).toMatchObject({ code });
    }
    const badShape = [{}, { name: '' }, { name: '   ' }, { address: { state: 'XYZ' } }];
    for (const payload of [...badShape, { birth_date: '2023-02-30' }, { birth_date: 'ontem' }]) {
      const response = await call(server, 'PATCH', '/v1/me', who, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    const stored = await row(STAFF);
    expect(stored).toMatchObject({ phone: null, birth_date: null, cpf: null });
  });

  it('uma pessoa nunca lê nem altera o perfil de outra, nem se promove por aqui', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);
    await call(server, 'PATCH', '/v1/me', owner, { name: 'Dono Original', cpf: CPF });

    const attack = await call(server, 'PATCH', '/v1/me', staff, {
      name: 'Funcionário',
      email: 'outro@example.com',
      is_platform_admin: true,
      id: SEED_IDS.userOwner,
      user_id: SEED_IDS.userOwner,
    });
    expect(attack.statusCode).toBe(200);
    expect(attack.json<MeJson>()).toMatchObject({
      email: STAFF,
      name: 'Funcionário',
      is_platform_admin: false,
      cpf_masked: null,
    });

    const ownerRow = await row(OWNER);
    expect(ownerRow).toMatchObject({ name: 'Dono Original' });
    expect(openCpf(ownerRow?.['cpf'])).toBe('52998224725');
    expect((await row(STAFF))?.['is_platform_admin']).toBe('false');
    const emails = await world.admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM users WHERE email = 'outro@example.com'",
    );
    expect(Number(emails.rows[0]?.n)).toBe(0);

    expect((await server.app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect(
      (await server.app.inject({ method: 'PATCH', url: '/v1/me', payload: { name: 'x' } }))
        .statusCode,
    ).toBe(401);
  });

  it('o painel do administrador e as respostas da loja não expõem os dados pessoais', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await call(server, 'PATCH', '/v1/me', owner, {
      cpf: CPF,
      phone: '11977665544',
      address: { street: 'Rua Secreta 77' },
    });
    const admin = await login(server, ADMIN);

    const detail = await call(server, 'GET', `/v1/admin/users/${SEED_IDS.userOwner}`, admin);
    const list = await call(server, 'GET', '/v1/admin/users?limit=100', admin);
    const team = await server.app.inject({
      method: 'GET',
      url: '/v1/team',
      headers: { authorization: `Bearer ${owner.token}`, 'x-store-id': SEED_IDS.storeA },
    });

    for (const body of [detail.body, list.body, team.body]) {
      expect(body).not.toContain('52998224725');
      expect(body).not.toContain('5511977665544');
      expect(body).not.toContain('Rua Secreta');
      expect(body).not.toContain('v1.');
    }
  });
});

describe('encerrar todas as sessões (DELETE /v1/me/sessions)', () => {
  it('encerra todas, inclusive a atual, e nenhuma renova depois', async () => {
    const server = await start();
    const first = await login(server, STAFF);
    const second = await login(server, STAFF);
    const other = await login(server, OWNER);

    const response = await call(server, 'DELETE', '/v1/me/sessions', first);

    expect(response.statusCode).toBe(204);
    const alive = await world.admin.query<{ email: string }>(
      `SELECT u.email FROM refresh_tokens r JOIN users u ON u.id = r.user_id
        WHERE r.revoked_at IS NULL`,
    );
    const emails = alive.rows.map((r) => r.email);
    expect(emails).not.toContain(STAFF);
    expect(emails).toContain(OWNER);
    for (const who of [first, second]) {
      const refreshed = await server.app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        cookies: { refresh_token: who.refresh },
      });
      expect(refreshed.statusCode).toBe(401);
    }
    const cleared = response.cookies.find((c) => c.name === 'refresh_token');
    expect(cleared?.value ?? '').toBe('');
    // a sessão de outra pessoa fica intacta
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          cookies: { refresh_token: other.refresh },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('com keep_current=true mantém só a sessão deste aparelho', async () => {
    const server = await start();
    const mine = await login(server, STAFF);
    await login(server, STAFF);
    await login(server, STAFF);

    const response = await call(server, 'DELETE', '/v1/me/sessions?keep_current=true', mine);

    expect(response.statusCode).toBe(204);
    const sessions = await call(server, 'GET', '/v1/me/sessions', mine);
    const items = sessions.json<{ items: { current: boolean }[] }>().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.current).toBe(true);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          cookies: { refresh_token: mine.refresh },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('exige login', async () => {
    const server = await start();
    expect((await server.app.inject({ method: 'DELETE', url: '/v1/me/sessions' })).statusCode).toBe(
      401,
    );
  });
});
