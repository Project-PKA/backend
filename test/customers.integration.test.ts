import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';
import { cpfVault, openCpf } from './helpers/cpf.js';

/** Sprint 04: clientes, visitantes, blacklist, perfil e carteira de consignação. Postgres real. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;

const customer = (n: number) => uid(KIND.customer, n);
const card = (n: number) => uid(KIND.card, n);
const VALID_CPF = '529.982.247-25';

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

interface CustomerJson {
  id: string;
  phone: string;
  name: string;
  kind: string;
  cpf_masked: string | null;
  is_blacklisted: boolean;
  blacklist_reason: string | null;
  address: Record<string, string | null>;
}

const fullAddress = {
  zip: '01310-100',
  street: 'Avenida Paulista',
  number: '1000',
  city: 'São Paulo',
  state: 'sp',
};

describe('cadastro (POST /v1/customers)', () => {
  it('cadastra um visitante só com telefone e nome', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'POST', '/v1/customers', staff, A, {
      phone: '(11) 98765-4321',
      name: '  Ash Ketchum ',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      phone: '5511987654321',
      name: 'Ash Ketchum',
      kind: 'VISITOR',
      cpf_masked: null,
      is_blacklisted: false,
    });
  });

  it('com CPF e endereço completos vira cliente; o CPF nunca volta inteiro', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'POST', '/v1/customers', staff, A, {
      phone: '11987654322',
      name: 'Misty',
      email: 'Misty@Example.COM',
      cpf: VALID_CPF,
      address: fullAddress,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json<CustomerJson & { email: string }>();
    expect(body).toMatchObject({
      kind: 'CUSTOMER',
      cpf_masked: '•••.•••.•••-25',
      email: 'misty@example.com',
      address: { zip: '01310100', state: 'SP' },
    });
    expect(response.body).not.toContain('52998224725');
    const { rows } = await world.admin.query<{
      cpf: string;
      cpf_last2: string;
      cpf_key_hash: string;
    }>('SELECT cpf, cpf_last2, cpf_key_hash FROM customers WHERE id = $1', [body.id]);
    // No banco o CPF está cifrado: nunca legível (ADR 0019).
    expect(rows[0]?.cpf).not.toContain('52998224725');
    expect(rows[0]?.cpf).toMatch(/^v1\./);
    expect(openCpf(rows[0]?.cpf)).toBe('52998224725');
    expect(rows[0]?.cpf_last2).toBe('25');
    expect(rows[0]?.cpf_key_hash).toBe(cpfVault.keyHash('5299'));
  });

  it('telefone repetido na mesma loja é 409; em outra loja pode', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const first = await call(server, 'POST', '/v1/customers', staff, A, {
      phone: '11987654323',
      name: 'Brock',
    });
    expect(first.statusCode).toBe(201);

    const again = await call(server, 'POST', '/v1/customers', staff, A, {
      phone: '+55 (11) 98765-4323',
      name: 'Outro Brock',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'CUSTOMER_PHONE_TAKEN' });

    const owner = await login(server, OWNER);
    const elsewhere = await call(server, 'POST', '/v1/customers', owner, B, {
      phone: '11987654323',
      name: 'Brock da loja B',
    });
    expect(elsewhere.statusCode).toBe(201);
  });

  it('cadastros simultâneos do mesmo telefone: só um vale', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(server, 'POST', '/v1/customers', staff, A, { phone: '11987654324', name: 'Gary' }),
      ),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(5);
  });

  it('valida telefone, CPF, CEP, e-mail e campos obrigatórios no servidor', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const post = (payload: unknown) => call(server, 'POST', '/v1/customers', staff, A, payload);

    expect((await post({ phone: '12345678', name: 'X' })).json()).toMatchObject({
      code: 'CUSTOMER_PHONE_INVALID',
    });
    expect(
      (await post({ phone: '11987654325', name: 'X', cpf: '111.111.111-11' })).json(),
    ).toMatchObject({ code: 'CUSTOMER_CPF_INVALID' });
    expect(
      (await post({ phone: '11987654325', name: 'X', address: { zip: '123' } })).json(),
    ).toMatchObject({ code: 'CUSTOMER_CEP_INVALID' });
    expect((await post({ phone: '11987654325', name: 'X', email: 'nao-e-email' })).statusCode).toBe(
      400,
    );
    expect((await post({ phone: '11987654325' })).statusCode).toBe(400);
    expect((await post({ name: 'X' })).statusCode).toBe(400);
    expect((await post({ phone: '11987654325', name: '' })).statusCode).toBe(400);
    expect(
      (await post({ phone: '11987654325', name: 'X', address: { state: 'SAO' } })).statusCode,
    ).toBe(400);
  });

  it('exige login, loja e a permissão de clientes', async () => {
    const server = await start();
    const anonymous = await server.app.inject({
      method: 'POST',
      url: '/v1/customers',
      payload: { phone: '11987654326', name: 'X' },
    });
    expect(anonymous.statusCode).toBe(401);

    await world.admin.query(
      `UPDATE store_members SET permissions = '{"can_manage_customers": false}'::jsonb
        WHERE user_id = $1 AND store_id = $2`,
      [SEED_IDS.userStaff, A],
    );
    const staff = await login(server, STAFF);
    const denied = await call(server, 'POST', '/v1/customers', staff, A, {
      phone: '11987654326',
      name: 'X',
    });
    expect(denied.statusCode).toBe(403);
    expect((await call(server, 'GET', '/v1/customers', staff, A)).statusCode).toBe(200);
    const blacklist = await call(
      server,
      'POST',
      `/v1/customers/${customer(1)}/blacklist`,
      staff,
      A,
      {},
    );
    expect(blacklist.statusCode).toBe(403);
  });
});

describe('edição (PATCH /v1/customers/:id)', () => {
  it('completar os dados do visitante o torna cliente; apagar o CPF o devolve a visitante', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const visitor = customer(26);

    const done = await call(server, 'PATCH', `/v1/customers/${visitor}`, staff, A, {
      cpf: VALID_CPF,
      address: fullAddress,
    });
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ kind: 'CUSTOMER', cpf_masked: '•••.•••.•••-25' });

    const undone = await call(server, 'PATCH', `/v1/customers/${visitor}`, staff, A, { cpf: null });
    expect(undone.json()).toMatchObject({ kind: 'VISITOR', cpf_masked: null });
  });

  it('o telefone não muda por aqui e o log guarda só os nomes dos campos', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const before = await call(server, 'GET', `/v1/customers/${customer(2)}`, staff, A);
    const phone = before.json<CustomerJson>().phone;

    const response = await call(server, 'PATCH', `/v1/customers/${customer(2)}`, staff, A, {
      phone: '11900000000',
      name: 'Novo Nome',
      cpf: VALID_CPF,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<CustomerJson>().phone).toBe(phone);
    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=3', owner, A);
    const entry = log.json<{ items: { action: string; details: { changed: string[] } }[] }>()
      .items[0];
    expect(entry?.action).toBe('customer.updated');
    expect(entry?.details.changed.sort((a, b) => a.localeCompare(b))).toEqual(['cpf', 'name']);
    expect(log.body).not.toContain('52998224725');
  });

  it('CPF inválido e corpo vazio são recusados; cliente de outra loja é 404', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const bad = await call(server, 'PATCH', `/v1/customers/${customer(2)}`, staff, A, {
      cpf: '123.456.789-00',
    });
    expect(bad.statusCode).toBe(422);
    const empty = await call(server, 'PATCH', `/v1/customers/${customer(2)}`, staff, A, {});
    expect(empty.statusCode).toBe(400);
    const foreign = await call(server, 'PATCH', `/v1/customers/${customer(101)}`, staff, A, {
      name: 'Invasor',
    });
    expect(foreign.statusCode).toBe(404);
    const { rows } = await world.admin.query<{ name: string }>(
      'SELECT name FROM customers WHERE id = $1',
      [customer(101)],
    );
    expect(rows[0]?.name).toBe('Cliente B1');
  });
});

describe('lista e perfil', () => {
  it('pagina por cursor sem repetir nem pular', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor === null ? '' : '&cursor=' + cursor;
      const url: string = '/v1/customers?limit=15' + suffix;
      const page = (await call(server, 'GET', url, staff, A)).json<{
        items: { id: string }[];
        next_cursor: string | null;
      }>();
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(40);
    expect(new Set(seen).size).toBe(40);
  });

  it('filtra por tipo, blacklist e consignador', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const list = async (query: string) =>
      (await call(server, 'GET', `/v1/customers?limit=100&${query}`, staff, A)).json<{
        items: CustomerJson[];
      }>().items;

    expect(await list('kind=VISITOR')).toHaveLength(12);
    expect(await list('kind=CUSTOMER')).toHaveLength(28);
    const black = await list('blacklisted=true');
    expect(black).toHaveLength(3);
    expect(black.every((c) => c.blacklist_reason !== null)).toBe(true);
    const consignors = await list('consignor=true');
    expect(consignors.map((c) => c.id).sort((a, b) => a.localeCompare(b))).toEqual(
      [customer(1), customer(2), customer(3), customer(4)].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('busca por nome (sem tratar % como curinga) e por telefone', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const find = async (q: string) =>
      (
        await call(server, 'GET', `/v1/customers?limit=100&q=${encodeURIComponent(q)}`, staff, A)
      ).json<{ items: CustomerJson[] }>().items;

    expect((await find('Cliente 08')).map((c) => c.id)).toEqual([customer(8)]);
    expect(await find('%')).toEqual([]);
    const byPhone = await find('900000012');
    expect(byPhone.map((c) => c.id)).toEqual([customer(12)]);
  });

  it('inativos: usa o limite da loja e exige que ele esteja definido', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    await world.admin.query(
      `UPDATE customers SET last_interaction_at = now() - interval '45 days' WHERE id = $1`,
      [customer(8)],
    );
    await world.admin.query(
      `UPDATE customers SET last_interaction_at = now() - interval '2 days' WHERE store_id = $1 AND id <> $2`,
      [A, customer(8)],
    );
    await world.admin.query(`UPDATE customers SET last_interaction_at = NULL WHERE id = $1`, [
      customer(9),
    ]);
    await world.admin.query('UPDATE stores SET inactivity_days_limit = 30 WHERE id = $1', [A]);

    const inactive = await call(server, 'GET', '/v1/customers?limit=100&inactive=true', staff, A);
    expect(
      inactive
        .json<{ items: CustomerJson[] }>()
        .items.map((c) => c.id)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([customer(8), customer(9)].sort((a, b) => a.localeCompare(b)));

    await world.admin.query('UPDATE stores SET inactivity_days_limit = NULL WHERE id = $1', [A]);
    const notSet = await call(server, 'GET', '/v1/customers?inactive=true', staff, A);
    expect(notSet.statusCode).toBe(409);
    expect(notSet.json()).toMatchObject({ code: 'CUSTOMER_INACTIVITY_NOT_SET' });
  });

  it('a lista não devolve CPF inteiro nem e-mail de quem não tem', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const response = await call(server, 'GET', '/v1/customers?limit=100', staff, A);
    const stored = await world.admin.query<{ cpf: string }>(
      'SELECT cpf FROM customers WHERE cpf IS NOT NULL',
    );
    expect(stored.rows.length).toBeGreaterThan(0);
    for (const { cpf } of stored.rows) {
      expect(response.body).not.toContain(cpf);
      expect(response.body).not.toContain(openCpf(cpf) ?? '');
    }
    expect(response.json<{ items: CustomerJson[] }>().items[0]).not.toHaveProperty('cpf');
  });

  it('cliente de outra loja é 404 em todas as rotas', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const foreign = customer(101);
    for (const [method, url, payload] of [
      ['GET', `/v1/customers/${foreign}`],
      ['PATCH', `/v1/customers/${foreign}`, { name: 'X' }],
      ['POST', `/v1/customers/${foreign}/blacklist`, {}],
      ['DELETE', `/v1/customers/${foreign}/blacklist`],
      ['GET', `/v1/customers/${foreign}/settlements`],
      ['GET', `/v1/customers/${foreign}/bids`],
    ] as const) {
      const response = await call(server, method, url, staff, A, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    const owner = await login(server, OWNER);
    const consignments = await call(
      server,
      'GET',
      `/v1/customers/${foreign}/consignments`,
      owner,
      A,
    );
    expect(consignments.statusCode).toBe(404);
    const list = await call(server, 'GET', '/v1/customers?limit=100', staff, A);
    expect(list.json<{ items: CustomerJson[] }>().items.some((c) => c.id === foreign)).toBe(false);
  });
});

describe('blacklist', () => {
  it('marca com motivo, desmarca e registra no log', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const marked = await call(server, 'POST', `/v1/customers/${customer(5)}/blacklist`, staff, A, {
      reason: 'Não pagou o acerto',
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toMatchObject({
      is_blacklisted: true,
      blacklist_reason: 'Não pagou o acerto',
    });

    const cleared = await call(
      server,
      'DELETE',
      `/v1/customers/${customer(5)}/blacklist`,
      staff,
      A,
    );
    expect(cleared.json()).toMatchObject({ is_blacklisted: false, blacklist_reason: null });

    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=4', owner, A);
    const actions = log.json<{ items: { action: string }[] }>().items.map((i) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['customer.blacklisted', 'customer.unblacklisted']),
    );
  });

  it('quem está na blacklist não consegue dar lance', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const created = await call(server, 'POST', '/v1/auctions', staff, A, {
      card_id: card(12),
      type: 'FREE_BID',
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      initial_bid: '10.00',
      min_increment: '2.00',
    });
    const auctionId = created.json<{ id: string }>().id;
    const bidAs = (who: string) =>
      call(server, 'POST', `/v1/auctions/${auctionId}/bids`, staff, A, {
        customer_id: who,
        amount: '10.00',
      });

    await call(server, 'POST', `/v1/customers/${customer(5)}/blacklist`, staff, A, {});
    const refused = await bidAs(customer(5));
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'BID_CUSTOMER_BLACKLISTED' });

    await call(server, 'DELETE', `/v1/customers/${customer(5)}/blacklist`, staff, A);
    expect((await bidAs(customer(5))).statusCode).toBe(201);
  });

  it('motivo grande demais é recusado', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const response = await call(
      server,
      'POST',
      `/v1/customers/${customer(5)}/blacklist`,
      staff,
      A,
      { reason: 'x'.repeat(301) },
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('perfil: acertos, histórico e carteira', () => {
  it('lista os acertos do cliente (aba Acerto), com filtro de status', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const { rows } = await world.admin.query<{ customer_id: string }>(
      'SELECT customer_id FROM settlements WHERE store_id = $1 LIMIT 1',
      [A],
    );
    const owner = rows[0]?.customer_id ?? '';

    const all = await call(server, 'GET', `/v1/customers/${owner}/settlements`, staff, A);
    expect(all.statusCode).toBe(200);
    const items = all.json<{ items: { status: string; items: number; total_amount: string }[] }>()
      .items;
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]?.items).toBeGreaterThan(0);

    const pending = await call(
      server,
      'GET',
      `/v1/customers/${owner}/settlements?status=PENDING`,
      staff,
      A,
    );
    expect(
      pending.json<{ items: { status: string }[] }>().items.every((i) => i.status === 'PENDING'),
    ).toBe(true);
    expect(
      (await call(server, 'GET', `/v1/customers/${owner}/settlements?cursor=lixo`, staff, A))
        .statusCode,
    ).toBe(400);
  });

  it('lista os lances do cliente (aba Histórico) e marca os que venceram', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const { rows } = await world.admin.query<{ customer_id: string }>(
      'SELECT b.customer_id FROM auctions a JOIN bids b ON b.id = a.winning_bid_id WHERE a.store_id = $1 LIMIT 1',
      [A],
    );
    const winner = rows[0]?.customer_id ?? '';

    const response = await call(server, 'GET', `/v1/customers/${winner}/bids?limit=50`, staff, A);

    expect(response.statusCode).toBe(200);
    const items = response.json<{ items: { won: boolean; card: { short_code: string } }[] }>()
      .items;
    expect(items.some((i) => i.won)).toBe(true);
    expect(items[0]?.card.short_code).toBeTruthy();
    expect(response.body).not.toContain('raw_whatsapp');
  });

  it('carteira: valor líquido é o lance menos a comissão, só com can_view_finance', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);

    // Carta consignada pelo cliente 1, 20% de comissão, vendida por 50,00 (líquido 40,00).
    const created = await call(server, 'POST', '/v1/cards', owner, A, {
      tcgdex_id: 'seed-003',
      language: 'PT',
      condition: 'NM',
      origin: 'CONSIGNED',
      consignor_id: customer(1),
      commission_pct: 20,
    });
    const cardId = created.json<{ id: string }>().id;
    const auction = await call(server, 'POST', '/v1/auctions', owner, A, {
      card_id: cardId,
      type: 'FREE_BID',
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      initial_bid: '10.00',
      min_increment: '5.00',
    });
    const auctionId = auction.json<{ id: string }>().id;
    for (const amount of ['10.00', '50.00']) {
      await call(server, 'POST', `/v1/auctions/${auctionId}/bids`, owner, A, {
        customer_id: customer(7),
        amount,
      });
    }
    await world.admin.query(
      `UPDATE auctions SET start_time = now() - interval '2 hours', end_time = now() - interval '1 minute' WHERE id = $1`,
      [auctionId],
    );
    await call(server, 'GET', '/v1/auctions', owner, A);

    const pending = await call(
      server,
      'GET',
      `/v1/customers/${customer(1)}/consignments`,
      owner,
      A,
    );
    expect(pending.statusCode).toBe(200);
    const body = pending.json<{
      items: {
        id: string;
        sale_amount: string | null;
        net_amount: string | null;
        card_status: string;
      }[];
      totals: { in_stock: number; pending_net: string; sold_net: string; commission: string };
    }>();
    const sold = body.items.find((i) => i.id === cardId);
    expect(sold).toMatchObject({
      card_status: 'AWAITING_CONFIRMATION',
      sale_amount: '50.00',
      net_amount: '40.00',
    });
    expect(body.totals.pending_net).toBe('40.00');
    expect(body.totals.commission).toBe('10.00');
    expect(body.totals.in_stock).toBeGreaterThan(0);

    await world.admin.query("UPDATE cards_inventory SET status = 'SOLD' WHERE id = $1", [cardId]);
    const confirmed = await call(
      server,
      'GET',
      `/v1/customers/${customer(1)}/consignments`,
      owner,
      A,
    );
    expect(
      confirmed.json<{ totals: { pending_net: string; sold_net: string } }>().totals,
    ).toMatchObject({
      pending_net: '0.00',
      sold_net: '40.00',
    });

    const denied = await call(server, 'GET', `/v1/customers/${customer(1)}/consignments`, staff, A);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'MISSING_PERMISSION' });
  });

  it('carteira de quem não consigna é vazia', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const response = await call(
      server,
      'GET',
      `/v1/customers/${customer(20)}/consignments`,
      owner,
      A,
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [],
      totals: { in_stock: 0, pending_net: '0.00', sold_net: '0.00', commission: '0.00' },
    });
  });
});
