import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/**
 * Sprint 05: leilões, lances (função `place_bid`), enquete com teto, extensão e alerta de queda do
 * WhatsApp. Postgres real, papel `app_api` (RLS valendo). O bot é Python e fica de fora.
 */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;

const card = (n: number) => uid(KIND.card, n);
const customer = (n: number) => uid(KIND.customer, n);
const BLACKLISTED = customer(38);
const OTHER_STORE_CUSTOMER = customer(101);

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

const inMinutes = (minutes: number): string =>
  new Date(Date.now() + minutes * 60_000).toISOString();

const terms = (overrides: Record<string, unknown> = {}) => ({
  card_id: card(12),
  type: 'FREE_BID',
  end_time: inMinutes(60),
  initial_bid: '10.00',
  min_increment: '2.00',
  ...overrides,
});

const pollTerms = (overrides: Record<string, unknown> = {}) =>
  terms({ type: 'POLL', max_poll_value: '30.00', ...overrides });

interface AuctionJson {
  id: string;
  status: string;
  current_bid: string | null;
  bid_count: number;
  ceiling_alert: boolean;
  winning_bid_id: string | null;
  end_time: string;
  leader: { id: string; name: string } | null;
}

async function createAuction(
  server: TestApp,
  session: Session,
  overrides: Record<string, unknown> = {},
  poll = false,
): Promise<AuctionJson> {
  const response = await call(
    server,
    'POST',
    '/v1/auctions',
    session,
    A,
    poll ? pollTerms(overrides) : terms(overrides),
  );
  expect(response.statusCode, response.body).toBe(201);
  return response.json<AuctionJson>();
}

const bid = (server: TestApp, session: Session, auctionId: string, who: string, amount: string) =>
  call(server, 'POST', `/v1/auctions/${auctionId}/bids`, session, A, {
    customer_id: who,
    amount,
  });

const cardStatus = async (n: number): Promise<string | undefined> =>
  (
    await world.admin.query<{ status: string }>(
      'SELECT status FROM cards_inventory WHERE id = $1',
      [card(n)],
    )
  ).rows[0]?.status;

const movePeriod = (auctionId: string, start: string, end: string) =>
  world.admin.query(
    `UPDATE auctions SET start_time = now() + $2::interval, end_time = now() + $3::interval WHERE id = $1`,
    [auctionId, start, end],
  );

describe('criar leilão (POST /v1/auctions)', () => {
  it('lança agora: o leilão abre e a carta vira SCHEDULED', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const created = await createAuction(server, staff);

    expect(created).toMatchObject({ status: 'ACTIVE', current_bid: null, bid_count: 0 });
    expect(await cardStatus(12)).toBe('SCHEDULED');
    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=3', owner, A);
    expect(log.json<{ items: { action: string }[] }>().items[0]?.action).toBe('auction.created');
  });

  it('agenda para depois: fica PENDING e a carta vira SCHEDULED', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const created = await createAuction(server, staff, {
      start_time: inMinutes(30),
      end_time: inMinutes(90),
    });

    expect(created.status).toBe('PENDING');
    expect(await cardStatus(12)).toBe('SCHEDULED');
  });

  it('só um leilão aberto por carta; carta em outro estado é recusada', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    await createAuction(server, staff);

    const again = await call(server, 'POST', '/v1/auctions', staff, A, terms());
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'AUCTION_CARD_NOT_AVAILABLE' });

    const sold = await call(server, 'POST', '/v1/auctions', staff, A, terms({ card_id: card(6) }));
    expect(sold.statusCode).toBe(409);
  });

  it('criações simultâneas da mesma carta: só uma vale', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => call(server, 'POST', '/v1/auctions', staff, A, terms())),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 409)).toHaveLength(4);
  });

  it.each([
    ['fim antes do início', { start_time: inMinutes(30), end_time: inMinutes(10) }],
    ['fim no passado', { end_time: new Date(Date.now() - 60_000).toISOString() }],
    ['início no passado distante', { start_time: inMinutes(-600), end_time: inMinutes(60) }],
    ['lance inicial zero', { initial_bid: '0.00' }],
    ['incremento zero', { min_increment: '0' }],
    ['lance livre com teto', { max_poll_value: '50.00' }],
  ])('recusa %s', async (_name, overrides) => {
    const server = await start();
    const staff = await login(server, STAFF);
    const response = await call(server, 'POST', '/v1/auctions', staff, A, terms(overrides));
    expect(response.statusCode).toBe(422);
    expect(await cardStatus(12)).toBe('AVAILABLE');
  });

  it('enquete exige teto acima do lance inicial', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    for (const bad of [
      pollTerms({ max_poll_value: null }),
      pollTerms({ max_poll_value: '10.00' }),
    ]) {
      expect((await call(server, 'POST', '/v1/auctions', staff, A, bad)).statusCode).toBe(422);
    }
    expect((await call(server, 'POST', '/v1/auctions', staff, A, pollTerms())).statusCode).toBe(
      201,
    );
  });

  it('valor malformado e campos extras: 400 ou descartados', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    for (const bad of [
      terms({ initial_bid: '10,50' }),
      terms({ initial_bid: '-5' }),
      terms({ initial_bid: '1.234' }),
      terms({ type: 'LEILAO' }),
      terms({ card_id: 'nao-uuid' }),
    ]) {
      expect((await call(server, 'POST', '/v1/auctions', staff, A, bad)).statusCode).toBe(400);
    }
  });

  it('carta de outra loja é 404 e nada muda lá', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const response = await call(
      server,
      'POST',
      '/v1/auctions',
      staff,
      A,
      terms({ card_id: uid(KIND.card, 1002) }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('exige login, loja e a permissão de leilões', async () => {
    const server = await start();
    const anonymous = await server.app.inject({
      method: 'POST',
      url: '/v1/auctions',
      payload: terms(),
    });
    expect(anonymous.statusCode).toBe(401);

    await world.admin.query(
      `UPDATE store_members SET permissions = '{"can_manage_auctions": false}'::jsonb
        WHERE user_id = $1 AND store_id = $2`,
      [SEED_IDS.userStaff, A],
    );
    const staff = await login(server, STAFF);
    const denied = await call(server, 'POST', '/v1/auctions', staff, A, terms());
    expect(denied.statusCode).toBe(403);
    expect((await call(server, 'GET', '/v1/auctions', staff, A)).statusCode).toBe(200);
  });
});

describe('lances (POST /v1/auctions/:id/bids → place_bid)', () => {
  it('aceita lances crescentes e mostra o líder', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);

    const first = await bid(server, staff, auction.id, customer(5), '10.00');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ amount: '10.00', auction_status: 'ACTIVE' });
    expect((await bid(server, staff, auction.id, customer(6), '12.00')).statusCode).toBe(201);

    const room = await call(server, 'GET', `/v1/auctions/${auction.id}`, staff, A);
    const body = room.json<{
      auction: AuctionJson;
      bids: { amount: string; customer: { phone_masked: string } }[];
    }>();
    expect(body.auction).toMatchObject({ current_bid: '12.00', bid_count: 2 });
    expect(body.auction.leader?.id).toBe(customer(6));
    expect(body.bids.map((b) => b.amount)).toEqual(['12.00', '10.00']);
    expect(body.bids[0]?.customer.phone_masked).toMatch(/^\d{5}•+\d{2}$/);
    expect(room.body).not.toContain('manualmente');
  });

  it('recusa lance abaixo do inicial e abaixo do incremento, e diz o mínimo', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);

    const low = await bid(server, staff, auction.id, customer(5), '9.99');
    expect(low.statusCode).toBe(422);
    expect(low.json()).toMatchObject({ code: 'BID_BID_TOO_LOW' });
    expect(low.json<{ detail: string }>().detail).toContain('10.00');

    await bid(server, staff, auction.id, customer(5), '10.00');
    for (const amount of ['10.00', '11.00', '11.99']) {
      const refused = await bid(server, staff, auction.id, customer(6), amount);
      expect(refused.statusCode).toBe(422);
    }
    expect((await bid(server, staff, auction.id, customer(6), '12.00')).statusCode).toBe(201);
  });

  it('recusa blacklist, cliente de outra loja e valor inválido', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);

    const black = await bid(server, staff, auction.id, BLACKLISTED, '10.00');
    expect(black.statusCode).toBe(422);
    expect(black.json()).toMatchObject({ code: 'BID_CUSTOMER_BLACKLISTED' });
    const foreign = await bid(server, staff, auction.id, OTHER_STORE_CUSTOMER, '10.00');
    expect(foreign.json()).toMatchObject({ code: 'BID_CUSTOMER_NOT_FOUND' });
    const zero = await bid(server, staff, auction.id, customer(5), '0');
    expect(zero.json()).toMatchObject({ code: 'BID_INVALID_AMOUNT' });

    const { rows } = await world.admin.query('SELECT 1 FROM bids WHERE auction_id = $1', [
      auction.id,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('não aceita lance antes de começar nem depois de terminar', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const future = await createAuction(server, staff, {
      start_time: inMinutes(30),
      end_time: inMinutes(90),
    });
    const notStarted = await bid(server, staff, future.id, customer(5), '10.00');
    expect(notStarted.statusCode).toBe(409);
    expect(notStarted.json()).toMatchObject({ code: 'BID_NOT_STARTED' });

    const live = await createAuction(server, staff, { card_id: card(13) });
    await movePeriod(live.id, '-2 hours', '-1 minute');
    const ended = await bid(server, staff, live.id, customer(5), '10.00');
    expect(ended.statusCode).toBe(409);
    expect(ended.json()).toMatchObject({ code: 'BID_ENDED' });
  });

  it('o primeiro lance abre o leilão cuja hora chegou', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const pending = await createAuction(server, staff, {
      start_time: inMinutes(30),
      end_time: inMinutes(90),
    });
    await movePeriod(pending.id, '-1 minute', '1 hour');

    const accepted = await bid(server, staff, pending.id, customer(5), '10.00');

    expect(accepted.statusCode).toBe(201);
    expect(accepted.json()).toMatchObject({ auction_status: 'ACTIVE' });
  });

  it('leilão de outra loja não existe para quem dá lance aqui', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const created = await call(
      server,
      'POST',
      '/v1/auctions',
      owner,
      B,
      terms({ card_id: uid(KIND.card, 1002) }),
    );
    expect(created.statusCode).toBe(201);
    const foreign = created.json<AuctionJson>();

    const staff = await login(server, STAFF);
    const response = await bid(server, staff, foreign.id, customer(5), '10.00');
    expect(response.statusCode).toBe(404);
    const { rows } = await world.admin.query('SELECT 1 FROM bids WHERE auction_id = $1', [
      foreign.id,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('place_bid chamada direto sob o RLS: loja errada não enxerga o leilão', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);

    const client = await world.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.store_id', $1, true)", [B]);
      const asB = await client.query<{ outcome: string }>(
        'SELECT outcome FROM place_bid($1, $2, $3, 10, $4)',
        [A, auction.id, customer(5), 'x'],
      );
      expect(asB.rows[0]?.outcome).toBe('AUCTION_NOT_FOUND');
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      const noContext = await client.query<{ outcome: string }>(
        'SELECT outcome FROM place_bid($1, $2, $3, 10, $4)',
        [A, auction.id, customer(5), 'x'],
      );
      expect(noContext.rows[0]?.outcome).toBe('AUCTION_NOT_FOUND');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });
});

describe('lances simultâneos (Postgres real)', () => {
  it('20 lances de valores diferentes ao mesmo tempo: o maior vence e nenhum fura o incremento', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);

    const amounts = Array.from({ length: 20 }, (_, i) => (10 + i * 2).toFixed(2));
    const responses = await Promise.all(
      amounts.map((amount, i) => bid(server, staff, auction.id, customer(5 + (i % 10)), amount)),
    );

    const codes = responses.map((r) => r.statusCode);
    expect(codes.every((c) => c === 201 || c === 422)).toBe(true);
    const { rows } = await world.admin.query<{ amount: string }>(
      'SELECT amount FROM bids WHERE auction_id = $1 ORDER BY created_at, amount',
      [auction.id],
    );
    const accepted = rows.map((r) => Number(r.amount));
    expect(accepted).toHaveLength(codes.filter((c) => c === 201).length);
    expect(Math.max(...accepted)).toBe(48);
    for (let i = 1; i < accepted.length; i += 1) {
      expect((accepted[i] ?? 0) - (accepted[i - 1] ?? 0)).toBeGreaterThanOrEqual(2);
    }
    const room = await call(server, 'GET', `/v1/auctions/${auction.id}`, staff, A);
    expect(room.json<{ auction: AuctionJson }>().auction.current_bid).toBe('48.00');
  });

  it('o mesmo valor ao mesmo tempo: só um é aceito', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        bid(server, staff, auction.id, customer(5 + i), '50.00'),
      ),
    );

    expect(responses.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(responses.filter((r) => r.statusCode === 422)).toHaveLength(9);
    const { rows } = await world.admin.query('SELECT 1 FROM bids WHERE auction_id = $1', [
      auction.id,
    ]);
    expect(rows).toHaveLength(1);
  });

  it('lances em leilões diferentes não se bloqueiam nem se misturam', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const one = await createAuction(server, staff);
    const two = await createAuction(server, staff, { card_id: card(13) });

    const responses = await Promise.all([
      ...Array.from({ length: 5 }, (_, i) =>
        bid(server, staff, one.id, customer(5), (10 + i * 2).toFixed(2)),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        bid(server, staff, two.id, customer(6), (10 + i * 2).toFixed(2)),
      ),
    ]);

    expect(responses.every((r) => r.statusCode === 201 || r.statusCode === 422)).toBe(true);
    const tops = await world.admin.query<{ auction_id: string; top: string }>(
      'SELECT auction_id, max(amount) AS top FROM bids WHERE auction_id = ANY($1::uuid[]) GROUP BY auction_id',
      [[one.id, two.id]],
    );
    expect(tops.rows.map((r) => r.top)).toEqual(['18.00', '18.00']);
  });
});

describe('enquete com teto', () => {
  it('ao atingir o teto marca o alerta e pausa sem encerrar; ninguém mais dá lance', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff, {}, true);

    await bid(server, staff, auction.id, customer(5), '20.00');
    const reached = await bid(server, staff, auction.id, customer(6), '30.00');
    expect(reached.statusCode).toBe(201);
    expect(reached.json()).toMatchObject({
      auction_status: 'PAUSED_FOR_VALIDATION',
      ceiling_reached: true,
    });

    const room = await call(server, 'GET', `/v1/auctions/${auction.id}`, staff, A);
    expect(room.json<{ auction: AuctionJson }>().auction).toMatchObject({
      status: 'PAUSED_FOR_VALIDATION',
      ceiling_alert: true,
      current_bid: '30.00',
      winning_bid_id: null,
    });
    const blocked = await bid(server, staff, auction.id, customer(7), '32.00');
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ code: 'BID_AUCTION_NOT_ACTIVE' });
  });

  it('manter aberta volta para ACTIVE e aceita novos lances', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff, {}, true);
    await bid(server, staff, auction.id, customer(5), '30.00');

    const kept = await call(server, 'POST', `/v1/auctions/${auction.id}/resolve`, staff, A, {
      decision: 'KEEP_OPEN',
    });

    expect(kept.statusCode).toBe(200);
    expect(kept.json()).toMatchObject({ status: 'ACTIVE', ceiling_alert: false });
    const next = await bid(server, staff, auction.id, customer(6), '32.00');
    expect(next.statusCode).toBe(201);
    expect(next.json()).toMatchObject({ auction_status: 'PAUSED_FOR_VALIDATION' });
  });

  it('aprovar encerra, define o vencedor e a carta aguarda confirmação', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff, {}, true);
    await bid(server, staff, auction.id, customer(5), '25.00');
    const top = await bid(server, staff, auction.id, customer(6), '31.00');
    const topId = top.json<{ bid_id: string }>().bid_id;

    const approved = await call(server, 'POST', `/v1/auctions/${auction.id}/resolve`, staff, A, {
      decision: 'APPROVE',
    });

    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: 'FINISHED', winning_bid_id: topId });
    expect(await cardStatus(12)).toBe('AWAITING_CONFIRMATION');
    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=3', owner, A);
    expect(log.json<{ items: { action: string }[] }>().items[0]?.action).toBe(
      'auction.poll_approved',
    );
  });

  it('só se resolve enquete que está aguardando validação', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff, {}, true);
    const response = await call(server, 'POST', `/v1/auctions/${auction.id}/resolve`, staff, A, {
      decision: 'APPROVE',
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: 'AUCTION_NOT_PAUSED' });
  });
});

describe('relógio: abrir e encerrar', () => {
  it('ao listar, a hora de abrir e de fechar é aplicada', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const withBids = await createAuction(server, staff);
    await bid(server, staff, withBids.id, customer(5), '10.00');
    const top = await bid(server, staff, withBids.id, customer(6), '14.00');
    const noBids = await createAuction(server, staff, { card_id: card(13) });
    const pending = await createAuction(server, staff, {
      card_id: card(14),
      start_time: inMinutes(30),
      end_time: inMinutes(90),
    });
    await movePeriod(withBids.id, '-2 hours', '-1 minute');
    await movePeriod(noBids.id, '-2 hours', '-1 minute');
    await movePeriod(pending.id, '-1 minute', '1 hour');

    const list = await call(server, 'GET', '/v1/auctions?limit=50', staff, A);

    const byId = new Map(
      list.json<{ items: AuctionJson[] }>().items.map((item) => [item.id, item]),
    );
    expect(byId.get(withBids.id)).toMatchObject({
      status: 'FINISHED',
      winning_bid_id: top.json<{ bid_id: string }>().bid_id,
    });
    expect(byId.get(noBids.id)?.status).toBe('FINISHED');
    expect(byId.get(pending.id)?.status).toBe('ACTIVE');
    expect(await cardStatus(12)).toBe('AWAITING_CONFIRMATION');
    expect(await cardStatus(13)).toBe('AVAILABLE');
    expect(await cardStatus(14)).toBe('SCHEDULED');
  });

  it('enquete aguardando o lojista não é encerrada pelo relógio', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff, {}, true);
    await bid(server, staff, auction.id, customer(5), '30.00');
    await movePeriod(auction.id, '-2 hours', '-1 minute');

    const room = await call(server, 'GET', `/v1/auctions/${auction.id}`, staff, A);

    expect(room.json<{ auction: AuctionJson }>().auction.status).toBe('PAUSED_FOR_VALIDATION');
  });

  it('virar o relógio várias vezes não muda o resultado', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);
    await bid(server, staff, auction.id, customer(5), '10.00');
    await movePeriod(auction.id, '-2 hours', '-1 minute');

    const first = await call(server, 'GET', '/v1/auctions', staff, A);
    const second = await call(server, 'GET', '/v1/auctions', staff, A);

    expect(first.json()).toEqual(second.json());
  });
});

describe('virada do relógio de todas as lojas (advanceAll)', () => {
  it('abre e encerra os leilões de cada loja, sem misturar', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);
    const inA = await createAuction(server, staff);
    await bid(server, staff, inA.id, customer(5), '10.00');
    const inB = await call(
      server,
      'POST',
      '/v1/auctions',
      owner,
      B,
      terms({ card_id: uid(KIND.card, 1002) }),
    );
    const idB = inB.json<AuctionJson>().id;
    await movePeriod(inA.id, '-2 hours', '-1 minute');
    await movePeriod(idB, '-2 hours', '-1 minute');

    const summary = await server.auctions.advanceAll();

    expect(summary.failed).toBe(0);
    expect(summary.stores).toBeGreaterThanOrEqual(3);
    expect(summary.finished).toBeGreaterThanOrEqual(2);
    const { rows } = await world.admin.query<{ id: string; status: string }>(
      'SELECT id, status FROM auctions WHERE id = ANY($1::uuid[])',
      [[inA.id, idB]],
    );
    expect(rows.map((r) => r.status)).toEqual(['FINISHED', 'FINISHED']);
    expect(await cardStatus(12)).toBe('AWAITING_CONFIRMATION');

    const again = await server.auctions.advanceAll();
    expect(again.finished).toBe(0);
  });
});

describe('editar, cancelar e estender', () => {
  it('leilão pendente aceita qualquer ajuste', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff, {
      start_time: inMinutes(30),
      end_time: inMinutes(90),
    });

    const response = await call(server, 'PATCH', `/v1/auctions/${auction.id}`, staff, A, {
      type: 'POLL',
      max_poll_value: '99.00',
      initial_bid: '15.00',
      start_time: inMinutes(45),
      end_time: inMinutes(120),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: 'POLL',
      max_poll_value: '99.00',
      initial_bid: '15.00',
    });
  });

  it('em andamento só o fim muda, e nunca para o passado', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);

    const locked = await call(server, 'PATCH', `/v1/auctions/${auction.id}`, staff, A, {
      initial_bid: '99.00',
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json()).toMatchObject({ code: 'AUCTION_AUCTION_LOCKED' });
    const past = await call(server, 'PATCH', `/v1/auctions/${auction.id}`, staff, A, {
      end_time: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(past.statusCode).toBe(422);
    const later = await call(server, 'PATCH', `/v1/auctions/${auction.id}`, staff, A, {
      end_time: inMinutes(180),
    });
    expect(later.statusCode).toBe(200);
  });

  it('a edição respeita as regras de enquete', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff, {
      start_time: inMinutes(30),
      end_time: inMinutes(90),
    });
    const noCeiling = await call(server, 'PATCH', `/v1/auctions/${auction.id}`, staff, A, {
      type: 'POLL',
    });
    expect(noCeiling.statusCode).toBe(422);
    const emptyBody = await call(server, 'PATCH', `/v1/auctions/${auction.id}`, staff, A, {});
    expect(emptyBody.statusCode).toBe(400);
  });

  it('cancelar devolve a carta ao estoque e mantém os lances', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);
    await bid(server, staff, auction.id, customer(5), '10.00');

    const cancelled = await call(server, 'POST', `/v1/auctions/${auction.id}/cancel`, staff, A);

    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({ status: 'CANCELLED', bid_count: 1 });
    expect(await cardStatus(12)).toBe('AVAILABLE');
    const again = await createAuction(server, staff);
    expect(again.status).toBe('ACTIVE');
    const finished = await call(server, 'POST', `/v1/auctions/${auction.id}/cancel`, staff, A);
    expect(finished.statusCode).toBe(409);
    const refused = await bid(server, staff, auction.id, customer(6), '50.00');
    expect(refused.statusCode).toBe(409);
  });

  it('não cancela leilão já encerrado', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);
    await bid(server, staff, auction.id, customer(5), '10.00');
    await movePeriod(auction.id, '-2 hours', '-1 minute');

    const response = await call(server, 'POST', `/v1/auctions/${auction.id}/cancel`, staff, A);

    expect(response.statusCode).toBe(409);
  });

  it('estende um leilão ou todos os que estão em andamento', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const one = await createAuction(server, staff);
    const two = await createAuction(server, staff, { card_id: card(13) }, true);
    const pending = await createAuction(server, staff, {
      card_id: card(14),
      start_time: inMinutes(30),
      end_time: inMinutes(90),
    });

    const single = await call(server, 'POST', `/v1/auctions/${one.id}/extend`, staff, A, {
      minutes: 15,
    });
    expect(single.statusCode).toBe(200);
    expect(Date.parse(single.json<AuctionJson>().end_time) - Date.parse(one.end_time)).toBe(
      15 * 60_000,
    );

    const all = await call(server, 'POST', '/v1/auctions/extend', staff, A, {});
    expect(all.statusCode).toBe(200);
    const extended = all.json<{ extended: string[] }>().extended;
    expect(extended).toEqual(expect.arrayContaining([one.id, two.id]));
    expect(extended).not.toContain(pending.id);

    const notLive = await call(server, 'POST', `/v1/auctions/${pending.id}/extend`, staff, A, {});
    expect(notLive.statusCode).toBe(409);
    expect(notLive.json()).toMatchObject({ code: 'AUCTION_NOT_LIVE' });
    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=5', owner, A);
    const actions = log.json<{ items: { action: string }[] }>().items.map((i) => i.action);
    expect(actions).toContain('auction.extended_all');
    expect(actions).toContain('auction.extended');
  });

  it('valida os minutos da extensão', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const auction = await createAuction(server, staff);
    for (const minutes of [0, -5, 1441]) {
      const response = await call(server, 'POST', `/v1/auctions/${auction.id}/extend`, staff, A, {
        minutes,
      });
      expect(response.statusCode).toBe(400);
    }
  });
});

describe('WhatsApp desconectado (GET /v1/auctions/affected)', () => {
  it('lista os leilões em andamento enquanto o WhatsApp não está online', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const live = await createAuction(server, staff);
    await createAuction(server, staff, {
      card_id: card(13),
      start_time: inMinutes(30),
      end_time: inMinutes(90),
    });

    await world.admin.query("UPDATE stores SET whatsapp_status = 'OFFLINE' WHERE id = $1", [A]);
    const offline = await call(server, 'GET', '/v1/auctions/affected', staff, A);
    const body = offline.json<{ whatsapp_status: string; items: AuctionJson[] }>();
    expect(body.whatsapp_status).toBe('OFFLINE');
    const ids = body.items.map((i) => i.id);
    expect(ids).toContain(live.id);
    expect(
      body.items.every((i) => i.status === 'ACTIVE' || i.status === 'PAUSED_FOR_VALIDATION'),
    ).toBe(true);

    await world.admin.query("UPDATE stores SET whatsapp_status = 'ONLINE' WHERE id = $1", [A]);
    const online = await call(server, 'GET', '/v1/auctions/affected', staff, A);
    expect(online.json<{ items: unknown[] }>().items).toEqual([]);
  });
});

describe('isolamento entre lojas', () => {
  it('leilão de uma loja é 404 em todas as rotas da outra', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const created = await call(
      server,
      'POST',
      '/v1/auctions',
      owner,
      B,
      terms({ card_id: uid(KIND.card, 1002) }),
    );
    const foreign = created.json<AuctionJson>();
    const staff = await login(server, STAFF);

    const requests: [string, string, unknown?][] = [
      ['GET', `/v1/auctions/${foreign.id}`],
      ['PATCH', `/v1/auctions/${foreign.id}`, { end_time: inMinutes(500) }],
      ['POST', `/v1/auctions/${foreign.id}/cancel`],
      ['POST', `/v1/auctions/${foreign.id}/resolve`, { decision: 'APPROVE' }],
      ['POST', `/v1/auctions/${foreign.id}/extend`, {}],
    ];
    for (const [method, url, payload] of requests) {
      const response = await call(server, method as 'GET', url, staff, A, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }

    const list = await call(server, 'GET', '/v1/auctions?limit=100', staff, A);
    expect(list.json<{ items: AuctionJson[] }>().items.some((i) => i.id === foreign.id)).toBe(
      false,
    );
    const stillThere = await call(server, 'GET', `/v1/auctions/${foreign.id}`, owner, B);
    expect(stillThere.json<{ auction: AuctionJson }>().auction.status).toBe('ACTIVE');
  });

  it('GET de id que não é uuid é 400', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    expect((await call(server, 'GET', '/v1/auctions/xxx', staff, A)).statusCode).toBe(400);
  });
});
