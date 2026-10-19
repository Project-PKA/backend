import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/** Sprint 06 (parte autenticada): acertos, pagamento pela loja. Sem frete nem envio (o sistema não trata disso). Postgres real. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
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

interface SettlementJson {
  id: string;
  status: string;
  total_amount: string;
  items_total: string;
  paid_at: string | null;
  customer: { id: string; kind: string };
  items: { auction_id: string; amount: string; card: { short_code: string } }[];
}

/** Leilão encerrado em que `buyer` deu o único (e vencedor) lance de `amount`. */
async function wonAuction(
  server: TestApp,
  session: Session,
  cardNumber: number,
  buyer: string,
  amount: string,
): Promise<string> {
  const created = await call(server, 'POST', '/v1/auctions', session, A, {
    card_id: card(cardNumber),
    type: 'FREE_BID',
    end_time: new Date(Date.now() + 3_600_000).toISOString(),
    initial_bid: '10.00',
    min_increment: '1.00',
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json<{ id: string }>().id;
  const placed = await call(server, 'POST', `/v1/auctions/${id}/bids`, session, A, {
    customer_id: buyer,
    amount,
  });
  expect(placed.statusCode, placed.body).toBe(201);
  await world.admin.query(
    `UPDATE auctions SET start_time = now() - interval '2 hours', end_time = now() - interval '1 minute' WHERE id = $1`,
    [id],
  );
  await call(server, 'GET', '/v1/auctions', session, A);
  return id;
}

const cardStatus = async (n: number): Promise<string | undefined> =>
  (
    await world.admin.query<{ status: string }>(
      'SELECT status FROM cards_inventory WHERE id = $1',
      [card(n)],
    )
  ).rows[0]?.status;

describe('fila "a acertar" (GET /v1/settlements/awaiting)', () => {
  it('agrupa por comprador, com subtotal, e inclui o visitante que ganhou', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    await wonAuction(server, staff, 12, customer(7), '30.00');
    await wonAuction(server, staff, 16, customer(7), '50.50');
    await wonAuction(server, staff, 17, customer(8), '12.00');

    const response = await call(server, 'GET', '/v1/settlements/awaiting', staff, A);

    expect(response.statusCode).toBe(200);
    const groups = response.json<{
      items: { customer: { id: string; kind: string }; subtotal: string; items: unknown[] }[];
    }>().items;
    const buyer7 = groups.find((g) => g.customer.id === customer(7));
    expect(buyer7).toMatchObject({ subtotal: '80.50' });
    expect(buyer7?.items).toHaveLength(2);
    expect(groups.find((g) => g.customer.id === customer(8))?.subtotal).toBe('12.00');
    const visitor = groups.find((g) => g.customer.id === customer(30));
    expect(visitor?.customer.kind).toBe('VISITOR');
  });

  it('não lista leilão que já está em acerto nem leilão sem lance', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const response = await call(server, 'GET', '/v1/settlements/awaiting', staff, A);
    const auctions = response
      .json<{ items: { items: { auction_id: string }[] }[] }>()
      .items.flatMap((g) => g.items.map((i) => i.auction_id));
    expect(auctions).toContain(uid(KIND.auction, 8));
    expect(auctions).not.toContain(uid(KIND.auction, 5));
    expect(auctions).not.toContain(uid(KIND.auction, 9));
  });
});

describe('criar acerto (POST /v1/settlements)', () => {
  it('total = soma dos itens; as cartas seguem aguardando', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const one = await wonAuction(server, staff, 12, customer(7), '30.00');
    const two = await wonAuction(server, staff, 16, customer(7), '50.00');

    const response = await call(server, 'POST', '/v1/settlements', staff, A, {
      customer_id: customer(7),
      auction_ids: [one, two, one],
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<SettlementJson>();
    expect(body).toMatchObject({
      status: 'PENDING',
      items_total: '80.00',
      total_amount: '80.00',
      paid_at: null,
    });
    expect(body.items).toHaveLength(2);
    expect(await cardStatus(12)).toBe('AWAITING_CONFIRMATION');

    const awaiting = await call(server, 'GET', '/v1/settlements/awaiting', staff, A);
    expect(
      awaiting.json<{ items: { customer: { id: string } }[] }>().items.map((g) => g.customer.id),
    ).not.toContain(customer(7));
    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=3', owner, A);
    expect(log.json<{ items: { action: string }[] }>().items[0]?.action).toBe('settlement.created');
  });

  it('recusa leilão de outro comprador, em andamento, sem vencedor, já acertado ou de outra loja', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);
    const mine = await wonAuction(server, staff, 12, customer(7), '30.00');
    const live = await call(server, 'POST', '/v1/auctions', staff, A, {
      card_id: card(16),
      type: 'FREE_BID',
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      initial_bid: '10.00',
      min_increment: '1.00',
    });
    const foreign = await call(server, 'POST', '/v1/auctions', owner, B, {
      card_id: uid(KIND.card, 1002),
      type: 'FREE_BID',
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      initial_bid: '10.00',
      min_increment: '1.00',
    });
    const create = (buyer: string, auctionIds: string[]) =>
      call(server, 'POST', '/v1/settlements', staff, A, {
        customer_id: buyer,
        auction_ids: auctionIds,
      });

    for (const bad of [
      create(customer(8), [mine]),
      create(customer(7), [live.json<{ id: string }>().id]),
      create(customer(7), [uid(KIND.auction, 9)]),
      create(customer(15), [uid(KIND.auction, 5)]),
      create(customer(7), [foreign.json<{ id: string }>().id]),
      create(customer(7), [mine, uid(KIND.auction, 5)]),
    ]) {
      const response = await bad;
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'SETTLEMENT_AUCTION_NOT_ELIGIBLE' });
    }
    const other = await create(customer(101), [mine]);
    expect(other.json()).toMatchObject({ code: 'SETTLEMENT_CUSTOMER_NOT_FOUND' });
    const { rows } = await world.admin.query(
      'SELECT 1 FROM settlement_items WHERE auction_id = $1',
      [mine],
    );
    expect(rows).toHaveLength(0);
  });

  it('criações simultâneas com o mesmo leilão: só um acerto vale', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const id = await wonAuction(server, staff, 12, customer(7), '30.00');

    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(server, 'POST', '/v1/settlements', staff, A, {
          customer_id: customer(7),
          auction_ids: [id],
        }),
      ),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 422)).toHaveLength(5);
    const { rows } = await world.admin.query(
      'SELECT 1 FROM settlement_items WHERE auction_id = $1',
      [id],
    );
    expect(rows).toHaveLength(1);
  });

  it('valida o corpo e a permissão', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const post = (payload: unknown) => call(server, 'POST', '/v1/settlements', staff, A, payload);
    expect((await post({ customer_id: customer(7), auction_ids: [] })).statusCode).toBe(400);
    expect((await post({ customer_id: customer(7), auction_ids: ['x'] })).statusCode).toBe(400);
    expect((await post({ auction_ids: [uid(KIND.auction, 8)] })).statusCode).toBe(400);

    await world.admin.query(
      `UPDATE store_members SET permissions = '{"can_manage_auctions": false}'::jsonb
        WHERE user_id = $1 AND store_id = $2`,
      [SEED_IDS.userStaff, A],
    );
    const denied = await post({ customer_id: customer(30), auction_ids: [uid(KIND.auction, 8)] });
    expect(denied.statusCode).toBe(403);
  });
});

describe('editar, desfazer e pagar', () => {
  async function pending(server: TestApp, staff: Session) {
    const id = await wonAuction(server, staff, 12, customer(7), '30.00');
    const created = await call(server, 'POST', '/v1/settlements', staff, A, {
      customer_id: customer(7),
      auction_ids: [id],
    });
    return created.json<SettlementJson>();
  }

  it('desfazer um acerto pendente devolve os leilões à fila; o pago não se desfaz', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const settlement = await pending(server, staff);

    const removed = await call(server, 'DELETE', `/v1/settlements/${settlement.id}`, staff, A);
    expect(removed.statusCode).toBe(204);
    const awaiting = await call(server, 'GET', '/v1/settlements/awaiting', staff, A);
    expect(
      awaiting.json<{ items: { customer: { id: string } }[] }>().items.map((g) => g.customer.id),
    ).toContain(customer(7));

    const paid = await call(
      server,
      'DELETE',
      `/v1/settlements/${uid(KIND.settlement, 1)}`,
      staff,
      A,
    );
    expect(paid.statusCode).toBe(409);
  });

  it('marcar como pago: só com can_view_finance; vira SOLD', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);
    const settlement = await pending(server, staff);

    const denied = await call(server, 'POST', `/v1/settlements/${settlement.id}/paid`, staff, A);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'MISSING_PERMISSION' });
    expect(await cardStatus(12)).toBe('AWAITING_CONFIRMATION');

    const paid = await call(server, 'POST', `/v1/settlements/${settlement.id}/paid`, owner, A);

    expect(paid.statusCode, paid.body).toBe(200);
    const body = paid.json<SettlementJson>();
    expect(body.status).toBe('PAID');
    expect(body.paid_at).not.toBeNull();
    expect(await cardStatus(12)).toBe('SOLD');
    const again = await call(server, 'POST', `/v1/settlements/${settlement.id}/paid`, owner, A);
    expect(again.statusCode).toBe(409);
    const log = await call(server, 'GET', '/v1/activity-log?limit=3', owner, A);
    expect(log.json<{ items: { action: string }[] }>().items[0]?.action).toBe('settlement.paid');
  });

  it('pagar duas vezes ao mesmo tempo: um pagamento só', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);
    const settlement = await pending(server, staff);

    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(server, 'POST', `/v1/settlements/${settlement.id}/paid`, owner, A),
      ),
    );

    expect(responses.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(3);
    const log = await call(server, 'GET', '/v1/activity-log?limit=50', owner, A);
    const paidEntries = log
      .json<{ items: { action: string }[] }>()
      .items.filter((entry) => entry.action === 'settlement.paid');
    expect(paidEntries).toHaveLength(1);
  });
});

describe('listar e isolamento', () => {
  it('lista com filtros e cursor, e o detalhe traz os itens', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const all = await call(server, 'GET', '/v1/settlements?limit=2', staff, A);
    const page = all.json<{ items: SettlementJson[]; next_cursor: string | null }>();
    expect(page.items).toHaveLength(2);
    expect(page.next_cursor).not.toBeNull();
    const rest = await call(
      server,
      'GET',
      `/v1/settlements?limit=10&cursor=${page.next_cursor}`,
      staff,
      A,
    );
    expect(rest.json<{ items: unknown[] }>().items).toHaveLength(2);

    const pendingOnly = await call(server, 'GET', '/v1/settlements?status=PENDING', staff, A);
    expect(pendingOnly.json<{ items: SettlementJson[] }>().items.map((s) => s.status)).toEqual([
      'PENDING',
    ]);
    const byBuyer = await call(
      server,
      'GET',
      `/v1/settlements?customer_id=${customer(17)}`,
      staff,
      A,
    );
    expect(byBuyer.json<{ items: SettlementJson[] }>().items).toHaveLength(1);

    const detail = await call(
      server,
      'GET',
      `/v1/settlements/${uid(KIND.settlement, 2)}`,
      staff,
      A,
    );
    const body = detail.json<SettlementJson>();
    expect(body).toMatchObject({ items_total: '110.00', total_amount: '110.00' });
    expect(body.items.map((i) => i.card.short_code)).toEqual(['A7', 'A8']);
    expect((await call(server, 'GET', '/v1/settlements?cursor=lixo', staff, A)).statusCode).toBe(
      400,
    );
  });

  it('acerto de outra loja é 404 em todas as rotas', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    await world.admin.query(
      `INSERT INTO settlements (id, store_id, customer_id, total_amount) VALUES ($1, $2, $3, 10)`,
      [uid(KIND.settlement, 900), B, customer(101)],
    );
    const foreign = uid(KIND.settlement, 900);
    const requests: [string, string, unknown?][] = [
      ['GET', `/v1/settlements/${foreign}`],
      ['DELETE', `/v1/settlements/${foreign}`],
      ['POST', `/v1/settlements/${foreign}/paid`],
    ];
    for (const [method, url, payload] of requests) {
      const response = await call(server, method as 'GET', url, owner, A, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    const list = await call(server, 'GET', '/v1/settlements?limit=100', staff, A);
    expect(list.json<{ items: SettlementJson[] }>().items.some((s) => s.id === foreign)).toBe(
      false,
    );
  });
});

describe('sem frete nem envio', () => {
  it('não existem rotas de frete, de envio nem de edição do acerto', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const id = uid(KIND.settlement, 1);
    const gone: [string, string, unknown?][] = [
      ['GET', '/v1/shipments?limit=10'],
      ['PATCH', `/v1/shipments/${id}`, { tracking_code: 'AA123456789BR' }],
      ['PATCH', `/v1/settlements/${id}`, { shipping_cost: '1' }],
    ];
    for (const [method, url, payload] of gone) {
      const response = await call(server, method as 'GET', url, owner, A, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });
});
