import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/** Sprint 07: Home ao vivo e Financeiro (único com período). Postgres real, papel `app_api`. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const OTHER_OWNER = 'outro-dono@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const card = (n: number) => uid(KIND.card, n);
const customer = (n: number) => uid(KIND.customer, n);

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

const get = (server: TestApp, url: string, session: Session, storeId: string) =>
  server.app.inject({ method: 'GET', url, headers: session.headers(storeId) });

const post = (server: TestApp, url: string, session: Session, storeId: string, payload?: unknown) =>
  server.app.inject({
    method: 'POST',
    url,
    headers: session.headers(storeId),
    payload: (payload ?? {}) as Record<string, unknown>,
  });

/** Cria o leilão da carta, dá um lance vencedor, encerra, cria o acerto e (opcionalmente) paga. */
async function sale(
  server: TestApp,
  owner: Session,
  cardNumber: number,
  buyer: string,
  amount: string,
  options: { pay?: boolean; paidDaysAgo?: number } = {},
): Promise<string> {
  const auction = await post(server, '/v1/auctions', owner, A, {
    card_id: card(cardNumber),
    type: 'FREE_BID',
    end_time: new Date(Date.now() + 3_600_000).toISOString(),
    initial_bid: '10.00',
    min_increment: '1.00',
  });
  expect(auction.statusCode, auction.body).toBe(201);
  const auctionId = auction.json<{ id: string }>().id;
  const bid = await post(server, `/v1/auctions/${auctionId}/bids`, owner, A, {
    customer_id: buyer,
    amount,
  });
  expect(bid.statusCode, bid.body).toBe(201);
  await world.admin.query(
    `UPDATE auctions SET start_time = now() - interval '2 hours', end_time = now() - interval '1 minute' WHERE id = $1`,
    [auctionId],
  );
  await get(server, '/v1/auctions', owner, A);
  const settlement = await post(server, '/v1/settlements', owner, A, {
    customer_id: buyer,
    auction_ids: [auctionId],
    shipping_cost: '9.90',
  });
  expect(settlement.statusCode, settlement.body).toBe(201);
  const id = settlement.json<{ id: string }>().id;
  if (options.pay === true) {
    expect((await post(server, `/v1/settlements/${id}/paid`, owner, A)).statusCode).toBe(200);
    if (options.paidDaysAgo !== undefined) {
      await world.admin.query(
        `UPDATE settlements SET paid_at = now() - make_interval(days => $2) WHERE id = $1`,
        [id, options.paidDaysAgo],
      );
    }
  }
  return id;
}

interface HomeJson {
  setup: Record<string, boolean>;
  poll_alerts: {
    auction_id: string;
    ceiling: string;
    current_bid: string;
    provisional_winner: { id: string } | null;
    card: { short_code: string };
  }[];
  kpis: Record<string, number>;
  cards_without_auction: { short_code: string }[];
  quick_settlements: { id: string; items: number; total_amount: string }[];
}

describe('Home ao vivo (GET /v1/dashboard/home)', () => {
  it('mostra o agora da loja: alerta de enquete, KPIs, lembrete e acertos rápidos', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await get(server, '/v1/dashboard/home', staff, A);

    expect(response.statusCode, response.body).toBe(200);
    const home = response.json<HomeJson>();
    expect(home.setup).toEqual({
      store_created: true,
      whatsapp_connected: true,
      first_card: true,
      first_auction: true,
    });
    expect(home.poll_alerts).toHaveLength(1);
    expect(home.poll_alerts[0]).toMatchObject({
      auction_id: uid(KIND.auction, 4),
      card: { short_code: 'A4' },
    });
    expect(home.poll_alerts[0]?.current_bid).toMatch(/^\d+\.\d{2}$/);
    expect(home.poll_alerts[0]?.provisional_winner).not.toBeNull();
    expect(home.kpis['active_auctions']).toBe(2);
    expect(home.kpis['pending_settlements']).toBe(1);
    expect(home.quick_settlements.map((s) => s.id)).toEqual([uid(KIND.settlement, 2)]);
    expect(home.quick_settlements[0]).toMatchObject({ items: 2, total_amount: '110.00' });

    const expected = await world.admin.query<{ n: string; bids: string }>(
      `SELECT (SELECT count(*) FROM cards_inventory c WHERE c.store_id = $1 AND c.status = 'AVAILABLE'
                  AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.card_id = c.id)) AS n,
              (SELECT count(*) FROM bids b JOIN auctions a ON a.id = b.auction_id
                WHERE b.store_id = $1 AND a.status IN ('ACTIVE', 'PAUSED_FOR_VALIDATION')) AS bids`,
      [A],
    );
    expect(home.kpis['cards_without_auction']).toBe(Number(expected.rows[0]?.n));
    expect(home.kpis['bids_in_active']).toBe(Number(expected.rows[0]?.bids));
    expect(home.cards_without_auction).toHaveLength(5);
  });

  it('leilões que acabaram saem do ar na própria consulta', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    await world.admin.query(
      `UPDATE auctions SET start_time = now() - interval '2 hours', end_time = now() - interval '1 minute' WHERE id = $1`,
      [uid(KIND.auction, 2)],
    );

    const home = (await get(server, '/v1/dashboard/home', staff, A)).json<HomeJson>();

    expect(home.kpis['active_auctions']).toBe(1);
  });

  it('o que está agendado para hoje entra no KPI; o de outro dia não', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    await world.admin.query(
      `UPDATE auctions SET start_time = now() + interval '1 minute', end_time = now() + interval '2 hours'
        WHERE id = $1`,
      [uid(KIND.auction, 1)],
    );
    const expected = await world.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM auctions WHERE store_id = $1 AND status = 'PENDING'
          AND (start_time AT TIME ZONE 'America/Sao_Paulo')::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date`,
      [A],
    );

    const home = (await get(server, '/v1/dashboard/home', staff, A)).json<HomeJson>();

    expect(home.kpis['scheduled_today']).toBe(Number(expected.rows[0]?.n));
  });

  it('loja nova: tudo zerado e o checklist de 4 passos', async () => {
    const server = await start();
    const created = await world.admin.query<{ id: string }>(
      "INSERT INTO stores (name) VALUES ('Loja Nova') RETURNING id",
    );
    const storeId = created.rows[0]?.id ?? '';
    await world.admin.query(
      "INSERT INTO store_members (store_id, user_id, role) VALUES ($1, $2, 'OWNER')",
      [storeId, SEED_IDS.userOtherOwner],
    );
    const other = await login(server, OTHER_OWNER);

    const home = (await get(server, '/v1/dashboard/home', other, storeId)).json<HomeJson>();

    expect(home.setup).toEqual({
      store_created: true,
      whatsapp_connected: false,
      first_card: false,
      first_auction: false,
    });
    expect(Object.values(home.kpis)).toEqual([0, 0, 0, 0, 0]);
    expect(home.poll_alerts).toEqual([]);
    expect(home.quick_settlements).toEqual([]);
  });

  it('não mistura lojas e exige login e participação', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);

    const storeB = (await get(server, '/v1/dashboard/home', owner, B)).json<HomeJson>();
    expect(storeB.poll_alerts).toEqual([]);
    expect(storeB.quick_settlements).toEqual([]);
    expect((await get(server, '/v1/dashboard/home', staff, B)).statusCode).toBe(403);
    const anonymous = await server.app.inject({ method: 'GET', url: '/v1/dashboard/home' });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe('Financeiro (GET /v1/finance/*)', () => {
  interface Overview {
    period: string;
    kpis: { revenue: string; profit: string; items_sold: number; average_item: string };
    daily: { day: string; revenue: string; profit: string }[];
    sales_by_price: { band: string; count: number }[];
    bids_by_hour: { hour: number; count: number }[];
    by_origin: { key: string; revenue: string; count: number }[];
    by_language: { key: string; revenue: string; count: number }[];
    by_condition: { key: string; revenue: string; count: number }[];
  }

  /** Duas vendas pagas hoje (uma própria, uma consignada), uma de 10 dias atrás e uma ainda pendente. */
  async function populate(server: TestApp, owner: Session): Promise<void> {
    await sale(server, owner, 12, customer(7), '30.00', { pay: true });
    // Carta 5: consignada pelo cliente 1, comissão de 15%.
    await sale(server, owner, 5, customer(8), '100.00', { pay: true });
    await sale(server, owner, 16, customer(7), '250.00', { pay: true, paidDaysAgo: 10 });
    await sale(server, owner, 17, customer(9), '500.00');
  }

  it('só quem tem can_view_finance vê; o período é validado', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);
    for (const path of ['overview', 'top-buyers', 'consignment-payouts']) {
      const denied = await get(server, `/v1/finance/${path}`, staff, A);
      expect(denied.statusCode, path).toBe(403);
      expect(denied.json()).toMatchObject({ code: 'MISSING_PERMISSION' });
      expect((await get(server, `/v1/finance/${path}`, owner, A)).statusCode, path).toBe(200);
      expect((await get(server, `/v1/finance/${path}?period=90`, owner, A)).statusCode, path).toBe(
        400,
      );
    }
  });

  it('KPIs, lucro e fatias contam só vendas pagas dentro do período', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await populate(server, owner);

    const week = (await get(server, '/v1/finance/overview?period=7', owner, A)).json<Overview>();

    expect(week.kpis).toEqual({
      revenue: '130.00',
      profit: '45.00',
      items_sold: 2,
      average_item: '65.00',
    });
    expect(week.by_origin).toEqual([
      { key: 'CONSIGNED', revenue: '100.00', count: 1 },
      { key: 'OWN', revenue: '30.00', count: 1 },
    ]);
    expect(week.by_language.reduce((sum, s) => sum + s.count, 0)).toBe(2);
    expect(week.by_condition.reduce((sum, s) => sum + s.count, 0)).toBe(2);
    expect(week.sales_by_price.find((b) => b.band === '25_TO_50')?.count).toBe(1);
    expect(week.sales_by_price.find((b) => b.band === '100_TO_200')?.count).toBe(1);
    expect(week.sales_by_price.find((b) => b.band === 'OVER_200')?.count).toBe(0);

    const fifteen = (
      await get(server, '/v1/finance/overview?period=15', owner, A)
    ).json<Overview>();
    expect(fifteen.kpis).toMatchObject({ revenue: '380.00', items_sold: 3 });
    expect(fifteen.sales_by_price.find((b) => b.band === 'OVER_200')?.count).toBe(1);
    const today = (
      await get(server, '/v1/finance/overview?period=today', owner, A)
    ).json<Overview>();
    expect(today.kpis.revenue).toBe('130.00');
    expect(today.daily).toHaveLength(1);
  });

  it('a série diária tem um ponto por dia, com zero nos dias sem venda', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await populate(server, owner);

    const month = (await get(server, '/v1/finance/overview?period=30', owner, A)).json<Overview>();

    expect(month.daily).toHaveLength(30);
    const days = month.daily.map((d) => d.day);
    expect([...days].sort((a, b) => a.localeCompare(b))).toEqual(days);
    const total = month.daily.reduce((sum, d) => sum + Number(d.revenue), 0);
    // As vendas do seed (acertos 3 e 4, de setembro) entram se caírem dentro dos 30 dias.
    const seeded = await world.admin.query<{ total: string }>(
      `SELECT coalesce(sum(si.amount), 0) AS total FROM settlements s
         JOIN settlement_items si ON si.settlement_id = s.id
        WHERE s.store_id = $1 AND s.status = 'PAID'
          AND (s.paid_at AT TIME ZONE 'America/Sao_Paulo')::date
              >= (now() AT TIME ZONE 'America/Sao_Paulo')::date - 29`,
      [A],
    );
    expect(total).toBe(Number(seeded.rows[0]?.total));
    expect(month.daily.filter((d) => d.revenue === '0.00').length).toBeGreaterThanOrEqual(20);
    expect(month.daily.at(-1)?.revenue).toBe('130.00');
  });

  it('lances por horário somam os lances do período', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await populate(server, owner);

    const week = (await get(server, '/v1/finance/overview?period=7', owner, A)).json<Overview>();

    expect(week.bids_by_hour).toHaveLength(24);
    const inWeek = await world.admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM bids WHERE store_id = $1 AND created_at >= now() - interval '7 days'",
      [A],
    );
    expect(week.bids_by_hour.reduce((sum, h) => sum + h.count, 0)).toBeGreaterThanOrEqual(
      Number(inWeek.rows[0]?.n) - 2,
    );
  });

  it('top compradores ordena pelo total pago e respeita o limite', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await populate(server, owner);

    const top = (await get(server, '/v1/finance/top-buyers?period=15', owner, A)).json<{
      items: { customer: { id: string }; purchases: number; total: string }[];
    }>().items;

    expect(top.map((t) => [t.customer.id, t.purchases, t.total])).toEqual([
      [customer(7), 2, '280.00'],
      [customer(8), 1, '100.00'],
    ]);
    const one = (await get(server, '/v1/finance/top-buyers?period=15&limit=1', owner, A)).json<{
      items: unknown[];
    }>();
    expect(one.items).toHaveLength(1);
    expect((await get(server, '/v1/finance/top-buyers?limit=0', owner, A)).statusCode).toBe(400);
    const week = (await get(server, '/v1/finance/top-buyers?period=7', owner, A)).json<{
      items: { customer: { id: string }; total: string }[];
    }>();
    expect(week.items.find((i) => i.customer.id === customer(7))?.total).toBe('30.00');
  });

  it('repasses: vendas pagas das cartas consignadas, menos a comissão da loja', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await populate(server, owner);

    const payouts = (await get(server, '/v1/finance/consignment-payouts?period=7', owner, A)).json<{
      items: {
        consignor: { id: string };
        items_sold: number;
        gross: string;
        commission: string;
        payout: string;
      }[];
    }>().items;

    expect(payouts).toEqual([
      {
        consignor: { id: customer(1), name: 'Cliente 01' },
        items_sold: 1,
        gross: '100.00',
        commission: '15.00',
        payout: '85.00',
      },
    ]);
  });

  it('loja sem vendas devolve zeros, e uma loja não enxerga a outra', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await populate(server, owner);

    const empty = (await get(server, '/v1/finance/overview?period=30', owner, B)).json<Overview>();

    expect(empty.kpis).toEqual({
      revenue: '0.00',
      profit: '0.00',
      items_sold: 0,
      average_item: '0.00',
    });
    expect(empty.by_origin).toEqual([]);
    expect(empty.daily).toHaveLength(30);
    const top = await get(server, '/v1/finance/top-buyers?period=30', owner, B);
    expect(top.json()).toEqual({ items: [] });
    const payouts = await get(server, '/v1/finance/consignment-payouts?period=30', owner, B);
    expect(payouts.json()).toEqual({ items: [] });
  });

  it('o frete não entra na receita', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    await sale(server, owner, 12, customer(7), '40.00', { pay: true });

    const today = (
      await get(server, '/v1/finance/overview?period=today', owner, A)
    ).json<Overview>();

    expect(today.kpis.revenue).toBe('40.00');
  });
});
