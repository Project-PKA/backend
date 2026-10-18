import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, SEED_LINK_TOKENS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/**
 * Sprint 06 (parte pública, ADR 0014 e D13): papel `public_runtime`, página do acerto, acompanhamento
 * do consignador e testes de abuso. Postgres real, papel `app_api` (RLS valendo).
 */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const PENDING_SETTLEMENT = uid(KIND.settlement, 2);
const PAID_SETTLEMENT = uid(KIND.settlement, 1);
const customer = (n: number) => uid(KIND.customer, n);
const VALID_CPF = '529.982.247-25';
const UNKNOWN_TOKEN = 'Z'.repeat(43);

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
  storeId: string | undefined,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: session.headers(storeId),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const publicCall = (
  server: TestApp,
  url: string,
  payload: unknown,
  remoteAddress = '203.0.113.10',
) =>
  server.app.inject({
    method: 'POST',
    url,
    payload: payload as Record<string, unknown>,
    remoteAddress,
  });

const settlementView = (server: TestApp, token: string, ip?: string) =>
  publicCall(server, '/v1/public/settlement', { token }, ip);
const consignorView = (server: TestApp, token: string, key: string, ip?: string) =>
  publicCall(server, '/v1/public/consignor', { token, key }, ip);

const address = {
  zip: '01310-100',
  street: 'Avenida Paulista',
  number: '1000',
  comp: 'Apto 12',
  city: 'São Paulo',
  state: 'sp',
};

describe('papel public_runtime (#57)', () => {
  const tables = async (): Promise<string[]> =>
    (
      await world.admin.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
    ).rows.map((r) => r.table_name);

  async function asPublicRole<T>(work: (query: (sql: string) => Promise<unknown>) => Promise<T>) {
    const client = await world.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE public_runtime');
      return await work((sql) => client.query(sql));
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('não é de login, não ignora RLS e não tem privilégio em nenhuma tabela', async () => {
    const role = await world.admin.query<{
      rolcanlogin: boolean;
      rolbypassrls: boolean;
      rolsuper: boolean;
    }>("SELECT rolcanlogin, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'public_runtime'");
    expect(role.rows[0]).toEqual({ rolcanlogin: false, rolbypassrls: false, rolsuper: false });

    for (const table of await tables()) {
      const privileges = await world.admin.query<{ ok: boolean }>(
        `SELECT has_table_privilege('public_runtime', $1, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') AS ok`,
        [`public.${table}`],
      );
      expect(privileges.rows[0]?.ok, table).toBe(false);
    }
  });

  it('com o papel real, nenhuma tabela pode ser lida direto', async () => {
    for (const table of await tables()) {
      const read = asPublicRole((query) => query(`SELECT * FROM "${table}" LIMIT 1`));
      await expect(read, table).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('só executa as três funções de entrada; ajudantes e funções de leilão são negados', async () => {
    const denied = [
      "SELECT place_bid(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'x')",
      'SELECT advance_auctions(gen_random_uuid())',
      "SELECT public_hash('x')",
      "SELECT public_ip_blocked('1.1.1.1')",
      "SELECT public_register_failure('1.1.1.1')",
      "SELECT public_resolve_link('x', 'SETTLEMENT', '1.1.1.1')",
    ];
    for (const statement of denied) {
      await expect(
        asPublicRole((query) => query(statement)),
        statement,
      ).rejects.toMatchObject({
        code: '42501',
      });
    }
    const allowed = await asPublicRole(async (query) => {
      await query(`SELECT public_settlement_view('${UNKNOWN_TOKEN}', '1.1.1.1')`);
      await query(`SELECT public_consignor_view('${UNKNOWN_TOKEN}', '0000', '1.1.1.1')`);
      return true;
    });
    expect(allowed).toBe(true);
  });

  it('o papel da API só chega nas funções públicas depois de assumir o papel público', async () => {
    await expect(
      world.appPool.query(`SELECT public_settlement_view('${UNKNOWN_TOKEN}', '1.1.1.1')`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('as funções públicas são SECURITY DEFINER com search_path fixo', async () => {
    const { rows } = await world.admin.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      `SELECT proname, prosecdef, proconfig FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname IN ('public_settlement_view', 'public_settlement_submit', 'public_consignor_view',
                          'public_resolve_link', 'public_register_failure', 'public_ip_blocked', 'public_hash')`,
    );
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(
        row.proconfig?.some((c) => c.startsWith('search_path=')),
        row.proname,
      ).toBe(true);
      if (row.proname !== 'public_hash') expect(row.prosecdef, row.proname).toBe(true);
    }
  });

  it('um papel de loja não lê o que é de outra nem a tabela de falhas por IP', async () => {
    await expect(world.appPool.query('SELECT * FROM public_ip_failures')).rejects.toMatchObject({
      code: '42501',
    });
    const client = await world.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.store_id', $1, true)", [B]);
      const links = await client.query('SELECT id FROM public_links');
      expect(links.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('gestão dos links (autenticada)', () => {
  it('gera o link do acerto: o token aparece uma vez e só o hash fica no banco', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const created = await call(
      server,
      'POST',
      `/v1/settlements/${PENDING_SETTLEMENT}/public-link`,
      staff,
      A,
      { expires_in_days: 7 },
    );

    expect(created.statusCode, created.body).toBe(201);
    const { link, token } = created.json<{ link: { id: string; state: string }; token: string }>();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(link.state).toBe('ACTIVE');
    const stored = await world.admin.query<{ token_hash: string }>(
      'SELECT token_hash FROM public_links WHERE id = $1',
      [link.id],
    );
    expect(stored.rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.token_hash).not.toContain(token);
    expect((await settlementView(server, token)).statusCode).toBe(200);

    const list = await call(server, 'GET', '/v1/public-links', staff, A);
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain('token_hash');
  });

  it('gerar de novo revoga o link anterior (um link ativo por alvo)', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    expect((await settlementView(server, SEED_LINK_TOKENS.settlement)).statusCode).toBe(200);

    const created = await call(
      server,
      'POST',
      `/v1/settlements/${PENDING_SETTLEMENT}/public-link`,
      staff,
      A,
      {},
    );

    expect(created.statusCode).toBe(201);
    expect((await settlementView(server, SEED_LINK_TOKENS.settlement)).statusCode).toBe(404);
    expect((await settlementView(server, created.json<{ token: string }>().token)).statusCode).toBe(
      200,
    );
  });

  it('revogar vale na hora e pode ser repetido', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const created = await call(
      server,
      'POST',
      `/v1/settlements/${PENDING_SETTLEMENT}/public-link`,
      staff,
      A,
      {},
    );
    const { link, token } = created.json<{ link: { id: string }; token: string }>();

    const revoked = await call(server, 'DELETE', `/v1/public-links/${link.id}`, staff, A);
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ state: 'REVOKED' });
    expect((await settlementView(server, token)).statusCode).toBe(404);
    expect((await call(server, 'DELETE', `/v1/public-links/${link.id}`, staff, A)).statusCode).toBe(
      200,
    );

    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=10', owner, A);
    const actions = log.json<{ items: { action: string }[] }>().items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['public_link.created', 'public_link.revoked']));
    expect(log.body).not.toContain(token);
  });

  it('o link do consignador exige CPF cadastrado', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const visitor = await call(
      server,
      'POST',
      `/v1/customers/${customer(30)}/consignor-link`,
      staff,
      A,
      {},
    );
    expect(visitor.statusCode).toBe(422);
    expect(visitor.json()).toMatchObject({ code: 'CONSIGNOR_CPF_REQUIRED' });
    const withCpf = await call(
      server,
      'POST',
      `/v1/customers/${customer(2)}/consignor-link`,
      staff,
      A,
      {},
    );
    expect(withCpf.statusCode).toBe(201);
    expect(withCpf.json<{ link: { kind: string } }>().link.kind).toBe('CONSIGNOR');
  });

  it('valida a validade, a permissão e a loja', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const url = `/v1/settlements/${PENDING_SETTLEMENT}/public-link`;
    for (const days of [0, 91, -1]) {
      expect(
        (await call(server, 'POST', url, staff, A, { expires_in_days: days })).statusCode,
      ).toBe(400);
    }
    const foreign = await call(
      server,
      'POST',
      `/v1/customers/${customer(101)}/consignor-link`,
      staff,
      A,
      {},
    );
    expect(foreign.statusCode).toBe(404);
    const owner = await login(server, OWNER);
    const otherStore = await call(server, 'POST', url, owner, B, {});
    expect(otherStore.statusCode).toBe(404);

    await world.admin.query(
      `UPDATE store_members SET permissions = '{"can_manage_auctions": false}'::jsonb
        WHERE user_id = $1 AND store_id = $2`,
      [SEED_IDS.userStaff, A],
    );
    expect((await call(server, 'POST', url, staff, A, {})).statusCode).toBe(403);
    const anonymous = await server.app.inject({ method: 'POST', url, payload: {} });
    expect(anonymous.statusCode).toBe(401);
  });

  it('um link de uma loja não pode ser revogado por outra', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const other = await world.admin.query<{ id: string }>(
      'SELECT id FROM public_links WHERE store_id = $1 LIMIT 1',
      [A],
    );
    const response = await call(
      server,
      'DELETE',
      `/v1/public-links/${other.rows[0]?.id}`,
      owner,
      B,
    );
    expect(response.statusCode).toBe(404);
    expect((await settlementView(server, SEED_LINK_TOKENS.settlement)).statusCode).toBe(200);
  });
});

describe('página pública do acerto (#52)', () => {
  it('mostra o resumo, o PIX da loja e o mínimo do comprador, com os cabeçalhos de proteção', async () => {
    const server = await start();

    const response = await settlementView(server, SEED_LINK_TOKENS.settlement);

    expect(response.statusCode).toBe(200);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-robots-tag']).toContain('noindex');
    expect(response.headers['cache-control']).toBe('no-store');
    const page = response.json<{
      store_name: string;
      pix_key: string | null;
      status: string;
      total_amount: string;
      items: { short_code: string; amount: string }[];
      buyer: { first_name: string; cpf_masked: string | null };
    }>();
    expect(page).toMatchObject({
      store_name: 'Cartas do Zé 🔥',
      pix_key: 'pix@cartasdoze.example.com',
      status: 'PENDING',
      total_amount: '110.00',
    });
    expect(page.items.map((i) => i.short_code)).toEqual(['A7', 'A8']);
    expect(page.buyer.first_name).toBe('Cliente');
    expect(page.buyer.cpf_masked).toMatch(/^•••\.•••\.•••-\d{2}$/);
  });

  it('nunca devolve CPF inteiro, e-mail, telefone nem endereço completo', async () => {
    const server = await start();
    const response = await settlementView(server, SEED_LINK_TOKENS.settlement);
    const buyer = await world.admin.query<{
      cpf: string;
      email: string | null;
      phone: string;
      address_street: string;
      address_zip: string;
    }>('SELECT cpf, email, phone, address_street, address_zip FROM customers WHERE id = $1', [
      customer(17),
    ]);
    const row = buyer.rows[0];
    for (const secret of [
      row?.cpf,
      row?.email,
      row?.phone,
      row?.address_street,
      row?.address_zip,
    ]) {
      if (secret) expect(response.body).not.toContain(secret);
    }
  });

  it('a chave PIX vem da configuração da loja (só o proprietário altera)', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);

    const denied = await call(server, 'PATCH', '/v1/store', staff, A, { pix_key: 'outra@pix.com' });
    expect(denied.statusCode).toBe(403);
    const changed = await call(server, 'PATCH', '/v1/store', owner, A, { pix_key: 'nova@pix.com' });
    expect(changed.json()).toMatchObject({ pix_key: 'nova@pix.com' });
    expect((await settlementView(server, SEED_LINK_TOKENS.settlement)).json()).toMatchObject({
      pix_key: 'nova@pix.com',
    });
    const cleared = await call(server, 'PATCH', '/v1/store', owner, A, { pix_key: null });
    expect(cleared.json()).toMatchObject({ pix_key: null });
    expect((await call(server, 'PATCH', '/v1/store', owner, A, { pix_key: '' })).statusCode).toBe(
      400,
    );
  });

  it('acerto já pago não mostra mais o PIX', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const created = await call(
      server,
      'POST',
      `/v1/settlements/${PAID_SETTLEMENT}/public-link`,
      staff,
      A,
      {},
    );
    const page = await settlementView(server, created.json<{ token: string }>().token);
    expect(page.json()).toMatchObject({ status: 'PAID', pix_key: null });
  });

  it('o comprador envia CPF e endereço com consentimento: grava, registra e atualiza o cadastro', async () => {
    const server = await start();
    const submitted = await publicCall(
      server,
      '/v1/public/settlement/data',
      {
        token: SEED_LINK_TOKENS.settlement,
        cpf: VALID_CPF,
        address,
        consent: { accepted: true, version: '2026-10-v1' },
      },
      '198.51.100.7',
    );

    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json()).toEqual({ result: 'OK' });
    const stored = await world.admin.query<{
      cpf: string;
      address_zip: string;
      address_state: string;
      is_visitor: boolean;
    }>('SELECT cpf, address_zip, address_state, is_visitor FROM customers WHERE id = $1', [
      customer(17),
    ]);
    expect(stored.rows[0]).toEqual({
      cpf: '52998224725',
      address_zip: '01310100',
      address_state: 'SP',
      is_visitor: false,
    });
    const consent = await world.admin.query<{
      text_version: string;
      ip: string;
      customer_id: string;
    }>(
      'SELECT text_version, host(ip) AS ip, customer_id FROM lgpd_consents WHERE settlement_id = $1',
      [PENDING_SETTLEMENT],
    );
    expect(consent.rows).toEqual([
      { text_version: '2026-10-v1', ip: '198.51.100.7', customer_id: customer(17) },
    ]);
    const log = await world.admin.query<{ details: object; actor_user_id: string | null }>(
      "SELECT details, actor_user_id FROM activity_log WHERE action = 'settlement.buyer_data_submitted'",
    );
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]?.actor_user_id).toBeNull();
    expect(JSON.stringify(log.rows[0]?.details)).not.toContain('52998224725');
  });

  it('sem consentimento, CPF inválido ou CEP inválido: nada é gravado', async () => {
    const server = await start();
    const before = await world.admin.query('SELECT cpf FROM customers WHERE id = $1', [
      customer(17),
    ]);
    const send = (overrides: Record<string, unknown>) =>
      publicCall(server, '/v1/public/settlement/data', {
        token: SEED_LINK_TOKENS.settlement,
        cpf: VALID_CPF,
        address,
        consent: { accepted: true, version: 'v1' },
        ...overrides,
      });

    const noConsent = await send({ consent: { accepted: false, version: 'v1' } });
    expect(noConsent.statusCode).toBe(422);
    expect(noConsent.json()).toMatchObject({ code: 'PUBLIC_CONSENT_REQUIRED' });
    expect((await send({ cpf: '111.111.111-11' })).json()).toMatchObject({
      code: 'PUBLIC_CPF_INVALID',
    });
    expect((await send({ cpf: '529.982.247-24' })).statusCode).toBe(422);
    expect((await send({ address: { ...address, zip: '123' } })).json()).toMatchObject({
      code: 'PUBLIC_CEP_INVALID',
    });
    expect((await send({ address: { ...address, state: 'SAO' } })).statusCode).toBe(400);
    expect((await send({ consent: { accepted: true } })).statusCode).toBe(400);

    const after = await world.admin.query('SELECT cpf FROM customers WHERE id = $1', [
      customer(17),
    ]);
    expect(after.rows).toEqual(before.rows);
    const consents = await world.admin.query('SELECT 1 FROM lgpd_consents');
    expect(consents.rowCount).toBe(0);
  });

  it('com token inválido o envio responde igual à consulta e não grava nada', async () => {
    const server = await start();
    const response = await publicCall(server, '/v1/public/settlement/data', {
      token: UNKNOWN_TOKEN,
      cpf: VALID_CPF,
      address,
      consent: { accepted: true, version: 'v1' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'PUBLIC_LINK_NOT_FOUND' });
    const consents = await world.admin.query('SELECT 1 FROM lgpd_consents');
    expect(consents.rowCount).toBe(0);
  });

  it('o token não funciona em outro tipo de página', async () => {
    const server = await start();
    expect((await consignorView(server, SEED_LINK_TOKENS.settlement, '0000')).statusCode).toBe(404);
    expect((await settlementView(server, SEED_LINK_TOKENS.consignor)).statusCode).toBe(404);
  });

  it('não existe rota GET com token na URL', async () => {
    const server = await start();
    for (const url of [
      `/v1/public/settlement/${SEED_LINK_TOKENS.settlement}`,
      `/v1/public/settlement?token=${SEED_LINK_TOKENS.settlement}`,
    ]) {
      const response = await server.app.inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(404);
      expect(response.body).not.toContain('Cartas do Zé');
    }
  });
});

describe('acompanhamento do consignador (#56)', () => {
  async function liveAuctionOnConsignedCard(server: TestApp) {
    const owner = await login(server, OWNER);
    // Carta 5: consignada pelo cliente 1, comissão de 15%.
    const created = await call(server, 'POST', '/v1/auctions', owner, A, {
      card_id: uid(KIND.card, 5),
      type: 'FREE_BID',
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      initial_bid: '10.00',
      min_increment: '5.00',
    });
    const id = created.json<{ id: string }>().id;
    for (const [who, amount] of [
      [7, '20.00'],
      [8, '100.00'],
    ] as const) {
      await call(server, 'POST', `/v1/auctions/${id}/bids`, owner, A, {
        customer_id: customer(who),
        amount,
      });
    }
  }

  it('com token e os 4 primeiros dígitos do CPF mostra as cartas, os lances e a estimativa', async () => {
    const server = await start();
    await liveAuctionOnConsignedCard(server);

    const response = await consignorView(server, SEED_LINK_TOKENS.consignor, '0000');

    expect(response.statusCode, response.body).toBe(200);
    const page = response.json<{
      store_name: string;
      estimate_is_final: boolean;
      cards: {
        short_code: string;
        commission_pct: string;
        auction: {
          current_bid: string;
          bid_count: number;
          estimated_payout: string;
          bids: { amount: string; phone: string }[];
        } | null;
      }[];
    }>();
    expect(page.estimate_is_final).toBe(false);
    const card = page.cards.find((c) => c.short_code === 'A5');
    expect(card?.auction).toMatchObject({
      current_bid: '100.00',
      bid_count: 2,
      estimated_payout: '85.00',
    });
    expect(card?.auction?.bids.map((b) => b.amount)).toEqual(['100.00', '20.00']);
    for (const bid of card?.auction?.bids ?? []) expect(bid.phone).toMatch(/^\d{5}•+\d{2}$/);
  });

  it('só traz as cartas dele, e nada de CPF, e-mail ou telefone inteiro', async () => {
    const server = await start();
    await liveAuctionOnConsignedCard(server);
    const response = await consignorView(server, SEED_LINK_TOKENS.consignor, '0000');

    const mine = await world.admin.query<{ short_code: string }>(
      'SELECT short_code FROM cards_inventory WHERE consignor_id = $1',
      [customer(1)],
    );
    const shown = response
      .json<{ cards: { short_code: string }[] }>()
      .cards.map((c) => c.short_code);
    const expected = mine.rows.map((r) => r.short_code);
    shown.sort((a, b) => a.localeCompare(b));
    expected.sort((a, b) => a.localeCompare(b));
    expect(shown).toEqual(expected);
    const secrets = await world.admin.query<{ cpf: string; phone: string; email: string | null }>(
      'SELECT cpf, phone, email FROM customers WHERE store_id = $1',
      [A],
    );
    for (const row of secrets.rows) {
      expect(response.body).not.toContain(row.phone);
      if (row.cpf) expect(response.body).not.toContain(row.cpf);
      if (row.email) expect(response.body).not.toContain(row.email);
    }
  });

  it('chave errada responde exatamente igual a link inválido', async () => {
    const server = await start();
    const wrongKey = await consignorView(
      server,
      SEED_LINK_TOKENS.consignor,
      '9999',
      '198.51.100.20',
    );
    const unknown = await consignorView(server, UNKNOWN_TOKEN, '0000', '198.51.100.21');

    expect(wrongKey.statusCode).toBe(404);
    expect(wrongKey.body).toBe(unknown.body);
    expect(wrongKey.headers['content-type']).toBe(unknown.headers['content-type']);
  });

  it('5 chaves erradas bloqueiam o link, até com a chave certa; depois do prazo volta', async () => {
    const server = await start();
    for (let i = 0; i < 5; i += 1) {
      const wrong = await consignorView(
        server,
        SEED_LINK_TOKENS.consignor,
        String(1000 + i),
        `198.51.100.${30 + i}`,
      );
      expect(wrong.statusCode).toBe(404);
    }
    const locked = await world.admin.query<{ locked_until: Date | null; failed_attempts: number }>(
      "SELECT locked_until, failed_attempts FROM public_links WHERE kind = 'CONSIGNOR'",
    );
    expect(locked.rows[0]?.locked_until).not.toBeNull();

    const correct = await consignorView(
      server,
      SEED_LINK_TOKENS.consignor,
      '0000',
      '198.51.100.99',
    );
    expect(correct.statusCode).toBe(404);
    const staff = await login(server, STAFF);
    const list = await call(server, 'GET', '/v1/public-links?kind=CONSIGNOR', staff, A);
    expect(list.json<{ items: { state: string }[] }>().items[0]?.state).toBe('LOCKED');

    await world.admin.query(
      "UPDATE public_links SET locked_until = now() - interval '1 minute' WHERE kind = 'CONSIGNOR'",
    );
    const again = await consignorView(server, SEED_LINK_TOKENS.consignor, '0000', '198.51.100.99');
    expect(again.statusCode).toBe(200);
  });

  it('acertar a chave zera o contador de erros', async () => {
    const server = await start();
    for (let i = 0; i < 3; i += 1) {
      await consignorView(server, SEED_LINK_TOKENS.consignor, '1234', `198.51.100.${50 + i}`);
    }
    expect(
      (await consignorView(server, SEED_LINK_TOKENS.consignor, '0000', '198.51.100.60')).statusCode,
    ).toBe(200);
    const row = await world.admin.query<{ failed_attempts: number }>(
      "SELECT failed_attempts FROM public_links WHERE kind = 'CONSIGNOR'",
    );
    expect(row.rows[0]?.failed_attempts).toBe(0);
  });

  it('consignador sem CPF não consegue entrar mesmo com um link forçado no banco', async () => {
    const server = await start();
    const token = 'N'.repeat(43);
    await world.admin.query(
      `INSERT INTO public_links (store_id, kind, customer_id, token_hash, expires_at)
       VALUES ($1, 'CONSIGNOR', $2, encode(sha256(convert_to($3, 'UTF8')), 'hex'), now() + interval '1 day')`,
      [A, customer(30), token],
    );
    for (const key of ['0000', '1111']) {
      expect((await consignorView(server, token, key, '198.51.100.70')).statusCode).toBe(404);
    }
  });
});

describe('testes de abuso (#58)', () => {
  it('enumeração: tokens aleatórios válidos no formato dão sempre a mesma resposta', async () => {
    const server = await start();
    const bodies = new Set<string>();
    for (let i = 0; i < 12; i += 1) {
      const token = `${String(i).padStart(2, '0')}${'k'.repeat(41)}`;
      const response = await settlementView(server, token, `198.51.100.${100 + i}`);
      expect(response.statusCode).toBe(404);
      bodies.add(response.body);
    }
    expect(bodies.size).toBe(1);
  });

  it('inexistente, expirado, revogado, bloqueado e tipo errado: respostas idênticas', async () => {
    const server = await start();
    await world.admin.query(
      `UPDATE public_links SET expires_at = now() - interval '1 second'
        WHERE token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')`,
      [SEED_LINK_TOKENS.settlement],
    );
    await world.admin.query(
      "UPDATE public_links SET locked_until = now() + interval '1 hour' WHERE kind = 'CONSIGNOR'",
    );

    const responses = await Promise.all([
      settlementView(server, UNKNOWN_TOKEN, '198.51.100.1'),
      settlementView(server, SEED_LINK_TOKENS.settlement, '198.51.100.2'),
      settlementView(server, SEED_LINK_TOKENS.revokedSettlement, '198.51.100.3'),
      consignorView(server, SEED_LINK_TOKENS.consignor, '0000', '198.51.100.4'),
      consignorView(server, SEED_LINK_TOKENS.settlement, '0000', '198.51.100.5'),
    ]);

    expect(new Set(responses.map((r) => r.statusCode))).toEqual(new Set([404]));
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
  });

  it('força bruta por IP: 20 falhas bloqueiam o IP, mesmo para um link válido; outro IP segue livre', async () => {
    const server = await start();
    const attacker = '192.0.2.50';
    for (let i = 0; i < 20; i += 1) {
      const token = `${String(i).padStart(2, '0')}${'x'.repeat(41)}`;
      expect((await settlementView(server, token, attacker)).statusCode).toBe(404);
    }

    const blocked = await settlementView(server, SEED_LINK_TOKENS.settlement, attacker);
    expect(blocked.statusCode).toBe(404);
    const otherIp = await settlementView(server, SEED_LINK_TOKENS.settlement, '192.0.2.51');
    expect(otherIp.statusCode).toBe(200);

    const row = await world.admin.query<{ ip_hash: string; locked_until: Date | null }>(
      'SELECT ip_hash, locked_until FROM public_ip_failures',
    );
    expect(row.rows[0]?.locked_until).not.toBeNull();
    expect(row.rows[0]?.ip_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.rows[0]?.ip_hash).not.toContain('192.0.2.50');

    await world.admin.query(
      "UPDATE public_ip_failures SET locked_until = now() - interval '1 second'",
    );
    expect((await settlementView(server, SEED_LINK_TOKENS.settlement, attacker)).statusCode).toBe(
      200,
    );
  });

  it('o IP bloqueado também não consegue chutar a chave do consignador', async () => {
    const server = await start();
    const attacker = '192.0.2.60';
    for (let i = 0; i < 20; i += 1) {
      await settlementView(server, `${String(i).padStart(2, '0')}${'y'.repeat(41)}`, attacker);
    }
    const attempt = await consignorView(server, SEED_LINK_TOKENS.consignor, '0000', attacker);
    expect(attempt.statusCode).toBe(404);
  });

  it('limite de requisições por minuto nas rotas públicas (429)', async () => {
    const server = await start({ RATE_LIMIT_PUBLIC_PER_MINUTE: '3' });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push(
        (await settlementView(server, SEED_LINK_TOKENS.settlement, '192.0.2.70')).statusCode,
      );
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect(
      (await settlementView(server, SEED_LINK_TOKENS.settlement, '192.0.2.71')).statusCode,
    ).toBe(200);
  });

  it('entradas malformadas não chegam ao banco (400) e injeção de SQL não faz efeito', async () => {
    const server = await start();
    for (const token of ["' OR 1=1 --", 'curto', 'x'.repeat(44), '../etc/passwd', '']) {
      const response = await publicCall(server, '/v1/public/settlement', { token });
      expect(response.statusCode, token).toBe(400);
    }
    for (const key of ['abcd', '12345', '123', "0000' OR '1'='1"]) {
      const response = await publicCall(server, '/v1/public/consignor', {
        token: SEED_LINK_TOKENS.consignor,
        key,
      });
      expect(response.statusCode, key).toBe(400);
    }
    const links = await world.admin.query('SELECT 1 FROM public_links');
    expect(links.rowCount).toBe(3);
  });

  it('as rotas públicas só aceitam POST e não vazam o token no log de erro', async () => {
    const server = await start();
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const response = await server.app.inject({ method, url: '/v1/public/settlement' });
      expect(response.statusCode, method).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, method).toBeLessThan(500);
    }
  });
});
