import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/** Sprint 03: estoque (cadastro, lista, detalhe, edição, exclusão). Postgres real, papel app_api. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;

const card = (n: number) => uid(KIND.card, n);
const consignorA = uid(KIND.customer, 1);
const customerB = uid(KIND.customer, 101);

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

const own = (overrides: Record<string, unknown> = {}) => ({
  tcgdex_id: 'seed-003',
  language: 'PT',
  condition: 'NM',
  origin: 'OWN',
  ...overrides,
});

describe('cadastro (POST /v1/cards)', () => {
  it('cadastra carta própria com código automático e registra no log', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(
      server,
      'POST',
      '/v1/cards',
      staff,
      A,
      own({ notes: 'Sem marcas' }),
    );

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      short_code: 'A61',
      origin: 'OWN',
      consignor: null,
      commission_pct: null,
      status: 'AVAILABLE',
      is_foil: false,
      notes: 'Sem marcas',
      catalog: { id: 'seed-003', name: 'Mew', rarity: 'Rare' },
    });

    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=5', owner, A);
    expect(log.json<{ items: { action: string }[] }>().items[0]?.action).toBe('card.created');
  });

  it('o código automático segue a sequência e respeita códigos informados', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const custom = await call(server, 'POST', '/v1/cards', staff, A, own({ short_code: 'pk9' }));
    expect(custom.json<{ short_code: string }>().short_code).toBe('PK9');
    const dup = await call(server, 'POST', '/v1/cards', staff, A, own({ short_code: 'PK9' }));
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ code: 'SHORT_CODE_TAKEN' });

    const auto = await call(server, 'POST', '/v1/cards', staff, A, own());
    expect(auto.json<{ short_code: string }>().short_code).toBe('A61');
    const next = await call(server, 'POST', '/v1/cards', staff, A, own());
    expect(next.json<{ short_code: string }>().short_code).toBe('A62');
  });

  it('o mesmo código pode existir em outra loja', async () => {
    const server = await start();
    const other = await login(server, OWNER);
    const response = await call(server, 'POST', '/v1/cards', other, B, own({ short_code: 'A1' }));
    expect(response.statusCode).toBe(409);
    const free = await call(server, 'POST', '/v1/cards', other, B, own({ short_code: 'A99' }));
    expect(free.statusCode).toBe(201);
  });

  it('cadastros simultâneos nunca repetem o código', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => call(server, 'POST', '/v1/cards', staff, A, own())),
    );

    expect(responses.map((r) => r.statusCode)).toEqual(Array.from({ length: 8 }, () => 201));
    const codes = responses.map((r) => r.json<{ short_code: string }>().short_code);
    expect(new Set(codes).size).toBe(8);
  });

  it('a origem é obrigatória, sem valor padrão', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const withoutOrigin: Record<string, unknown> = own();
    delete withoutOrigin['origin'];

    const response = await call(server, 'POST', '/v1/cards', staff, A, withoutOrigin);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('consignada exige consignador e comissão; própria não aceita nenhum', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const ok = await call(
      server,
      'POST',
      '/v1/cards',
      staff,
      A,
      own({ origin: 'CONSIGNED', consignor_id: consignorA, commission_pct: 12.5 }),
    );
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({
      origin: 'CONSIGNED',
      commission_pct: '12.50',
      consignor: { id: consignorA, name: 'Cliente 01' },
    });

    for (const bad of [
      own({ origin: 'CONSIGNED' }),
      own({ origin: 'CONSIGNED', consignor_id: consignorA }),
      own({ origin: 'CONSIGNED', commission_pct: 10 }),
      own({ origin: 'OWN', consignor_id: consignorA }),
      own({ origin: 'OWN', commission_pct: 10 }),
    ]) {
      const response = await call(server, 'POST', '/v1/cards', staff, A, bad);
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ code: 'OWNERSHIP_INVALID' });
    }
  });

  it('recusa consignador de outra loja e carta fora do catálogo', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const foreign = await call(
      server,
      'POST',
      '/v1/cards',
      staff,
      A,
      own({ origin: 'CONSIGNED', consignor_id: customerB, commission_pct: 10 }),
    );
    expect(foreign.statusCode).toBe(422);
    expect(foreign.json()).toMatchObject({ code: 'CONSIGNOR_NOT_FOUND' });

    const unknown = await call(
      server,
      'POST',
      '/v1/cards',
      staff,
      A,
      own({ tcgdex_id: 'nao-existe' }),
    );
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ code: 'CATALOG_CARD_NOT_FOUND' });
  });

  it('valida idioma, condição, comissão e campos extras', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    for (const bad of [
      own({ language: 'pt' }),
      own({ language: 'POR' }),
      own({ condition: 'PERFEITA' }),
      own({ origin: 'CONSIGNED', consignor_id: consignorA, commission_pct: 101 }),
      own({ short_code: 'tem espaço' }),
      own({ notes: 'x'.repeat(2001) }),
    ]) {
      expect((await call(server, 'POST', '/v1/cards', staff, A, bad)).statusCode).toBe(400);
    }
  });

  it('campo que não existe no contrato é descartado (a loja vem só do header)', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(
      server,
      'POST',
      '/v1/cards',
      staff,
      A,
      own({ store_id: B, status: 'SOLD', id: uid(KIND.card, 5) }),
    );

    expect(response.statusCode).toBe(201);
    const created = response.json<{ id: string; status: string }>();
    expect(created.status).toBe('AVAILABLE');
    const { rows } = await world.admin.query<{ store_id: string }>(
      'SELECT store_id FROM cards_inventory WHERE id = $1',
      [created.id],
    );
    expect(rows[0]?.store_id).toBe(A);
  });

  it('exige login, loja, participação e a permissão de estoque', async () => {
    const server = await start();
    const anonymous = await server.app.inject({ method: 'POST', url: '/v1/cards', payload: own() });
    expect(anonymous.statusCode).toBe(401);

    const staff = await login(server, STAFF);
    const foreignStore = await call(server, 'POST', '/v1/cards', staff, B, own());
    expect(foreignStore.statusCode).toBe(403);

    await world.admin.query(
      `UPDATE store_members SET permissions = '{"can_manage_inventory": false}'::jsonb
        WHERE user_id = $1 AND store_id = $2`,
      [SEED_IDS.userStaff, A],
    );
    const denied = await call(server, 'POST', '/v1/cards', staff, A, own());
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toMatchObject({ code: 'MISSING_PERMISSION' });
    const stillReads = await call(server, 'GET', '/v1/cards', staff, A);
    expect(stillReads.statusCode).toBe(200);
  });
});

describe('lista (GET /v1/cards)', () => {
  it('pagina por cursor sem repetir nem pular cartas', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const suffix: string = cursor === null ? '' : '&cursor=' + cursor;
      const url: string = '/v1/cards?limit=25' + suffix;
      const page = (await call(server, 'GET', url, staff, A)).json<{
        items: { id: string }[];
        next_cursor: string | null;
      }>();
      seen.push(...page.items.map((i) => i.id));
      cursor = page.next_cursor;
    } while (cursor !== null);

    expect(seen).toHaveLength(60);
    expect(new Set(seen).size).toBe(60);
  });

  it('só devolve as cartas da loja ativa', async () => {
    const server = await start();
    const other = await login(server, OWNER);

    const mine = (await call(server, 'GET', '/v1/cards?limit=100', other, B)).json<{
      items: { id: string; short_code: string }[];
    }>();

    expect(mine.items).toHaveLength(8);
    expect(mine.items.some((i) => i.id === card(1))).toBe(false);
  });

  it('filtra por status, origem, consignador e nunca leiloadas', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const list = async (query: string) =>
      (await call(server, 'GET', `/v1/cards?limit=100&${query}`, staff, A)).json<{
        items: { short_code: string; status: string; origin: string }[];
      }>().items;

    expect(
      (await list('status=SOLD')).map((i) => i.short_code).sort((a, b) => a.localeCompare(b)),
    ).toEqual(['A31', 'A32', 'A6']);
    const consigned = await list('origin=CONSIGNED');
    expect(consigned).toHaveLength(12);
    expect(consigned.every((i) => i.origin === 'CONSIGNED')).toBe(true);

    const never = await list('no_auction=true');
    const codes = never.map((i) => i.short_code);
    expect(codes).not.toContain('A1');
    expect(codes).not.toContain('A10');
    expect(codes).not.toContain('A11');
    expect(codes).toContain('A12');
  });

  it('busca por nome sem acento e pelo ID curto', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const names = async (q: string) =>
      (await call(server, 'GET', `/v1/cards?limit=100&q=${encodeURIComponent(q)}`, staff, A)).json<{
        items: { short_code: string; catalog: { name: string } }[];
      }>().items;

    const flabebe = await names('flabebe');
    expect(flabebe.length).toBeGreaterThan(0);
    expect(flabebe.every((i) => i.catalog.name === 'Flabébé')).toBe(true);

    const byCode = await names('a7');
    expect(byCode.map((i) => i.short_code)).toEqual(['A7']);
    expect(await names('%')).toHaveLength(60);
  });

  it('rejeita cursor inválido e filtro fora da lista', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    expect((await call(server, 'GET', '/v1/cards?cursor=lixo', staff, A)).statusCode).toBe(400);
    expect((await call(server, 'GET', '/v1/cards?status=XYZ', staff, A)).statusCode).toBe(400);
  });
});

describe('detalhe (GET /v1/cards/:id)', () => {
  it('traz a carta com o histórico de leilões', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'GET', `/v1/cards/${card(6)}`, staff, A);

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      card: { short_code: string; status: string };
      auctions: { status: string; winning_amount: string | null }[];
    }>();
    expect(body.card).toMatchObject({ short_code: 'A6', status: 'SOLD' });
    expect(body.auctions).toHaveLength(1);
    expect(body.auctions[0]?.status).toBe('FINISHED');
    expect(body.auctions[0]?.winning_amount).not.toBeNull();
  });

  it('carta de outra loja é 404, igual a carta inexistente', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const foreign = await call(server, 'GET', `/v1/cards/${uid(KIND.card, 1000)}`, staff, A);
    const missing = await call(server, 'GET', `/v1/cards/${uid(KIND.card, 99999)}`, staff, A);

    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json()).toEqual(missing.json());
    expect((await call(server, 'GET', '/v1/cards/nao-e-uuid', staff, A)).statusCode).toBe(400);
  });
});

describe('edição (PATCH /v1/cards/:id)', () => {
  it('edita os dados e registra no log', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const response = await call(server, 'PATCH', `/v1/cards/${card(12)}`, staff, A, {
      condition: 'HP',
      is_foil: true,
      notes: null,
      tcgdex_id: 'seed-001',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      condition: 'HP',
      is_foil: true,
      notes: null,
      catalog: { id: 'seed-001' },
    });
    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=3', owner, A);
    const entry = log.json<{ items: { action: string; details: { changed: string[] } }[] }>()
      .items[0];
    expect(entry?.action).toBe('card.updated');
    expect(entry?.details.changed).toEqual(
      expect.arrayContaining(['condition', 'isFoil', 'notes', 'tcgdexId']),
    );
  });

  it('muda a origem mantendo a consistência', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const toConsigned = await call(server, 'PATCH', `/v1/cards/${card(12)}`, staff, A, {
      origin: 'CONSIGNED',
      consignor_id: consignorA,
      commission_pct: 20,
    });
    expect(toConsigned.statusCode).toBe(200);
    expect(toConsigned.json()).toMatchObject({ origin: 'CONSIGNED', commission_pct: '20.00' });

    const missingPart = await call(server, 'PATCH', `/v1/cards/${card(13)}`, staff, A, {
      origin: 'CONSIGNED',
    });
    expect(missingPart.statusCode).toBe(422);

    const backToOwn = await call(server, 'PATCH', `/v1/cards/${card(12)}`, staff, A, {
      origin: 'OWN',
    });
    expect(backToOwn.statusCode).toBe(200);
    expect(backToOwn.json()).toMatchObject({
      origin: 'OWN',
      consignor: null,
      commission_pct: null,
    });
  });

  it('não edita carta em leilão, vendida ou aguardando confirmação', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    for (const n of [1, 2, 6, 7]) {
      const response = await call(server, 'PATCH', `/v1/cards/${card(n)}`, staff, A, {
        notes: 'tentando mudar',
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'CARD_LOCKED' });
    }
  });

  it('exige a permissão, recusa campo proibido e carta de outra loja', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const onlyStatus = await call(server, 'PATCH', `/v1/cards/${card(12)}`, staff, A, {
      status: 'SOLD',
    });
    expect(onlyStatus.statusCode).toBe(200);
    expect(onlyStatus.json()).toMatchObject({ status: 'AVAILABLE' });
    const empty = await call(server, 'PATCH', `/v1/cards/${card(12)}`, staff, A, {});
    expect(empty.statusCode).toBe(400);
    const foreign = await call(server, 'PATCH', `/v1/cards/${uid(KIND.card, 1000)}`, staff, A, {
      notes: 'invadindo',
    });
    expect(foreign.statusCode).toBe(404);
    const { rows } = await world.admin.query<{ notes: string | null }>(
      'SELECT notes FROM cards_inventory WHERE id = $1',
      [uid(KIND.card, 1000)],
    );
    expect(rows[0]?.notes).toBeNull();
  });
});

describe('exclusão (DELETE /v1/cards/:id)', () => {
  it('só quem tem can_delete exclui; o funcionário não', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const denied = await call(server, 'DELETE', `/v1/cards/${card(12)}`, staff, A);
    expect(denied.statusCode).toBe(403);

    const owner = await login(server, OWNER);
    const ok = await call(server, 'DELETE', `/v1/cards/${card(12)}`, owner, A);
    expect(ok.statusCode).toBe(204);
    expect((await call(server, 'GET', `/v1/cards/${card(12)}`, owner, A)).statusCode).toBe(404);

    const log = await call(server, 'GET', '/v1/activity-log?limit=3', owner, A);
    expect(log.json<{ items: { action: string }[] }>().items[0]?.action).toBe('card.deleted');
  });

  it('o funcionário exclui se o proprietário der a permissão', async () => {
    const server = await start();
    await world.admin.query(
      `UPDATE store_members SET permissions = '{"can_delete": true}'::jsonb
        WHERE user_id = $1 AND store_id = $2`,
      [SEED_IDS.userStaff, A],
    );
    const staff = await login(server, STAFF);
    expect((await call(server, 'DELETE', `/v1/cards/${card(13)}`, staff, A)).statusCode).toBe(204);
  });

  it('não exclui carta em leilão, vendida ou com histórico de leilão', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    for (const [n, code] of [
      [2, 'CARD_LOCKED'],
      [6, 'CARD_LOCKED'],
      [10, 'CARD_HAS_HISTORY'],
      [11, 'CARD_HAS_HISTORY'],
    ] as const) {
      const response = await call(server, 'DELETE', `/v1/cards/${card(n)}`, owner, A);
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code });
    }
    const { rows } = await world.admin.query('SELECT 1 FROM cards_inventory WHERE id = ANY($1)', [
      [card(2), card(6), card(10), card(11)],
    ]);
    expect(rows).toHaveLength(4);
  });

  it('não exclui carta de outra loja', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const response = await call(server, 'DELETE', `/v1/cards/${uid(KIND.card, 1001)}`, owner, A);
    expect(response.statusCode).toBe(404);
    const { rows } = await world.admin.query('SELECT 1 FROM cards_inventory WHERE id = $1', [
      uid(KIND.card, 1001),
    ]);
    expect(rows).toHaveLength(1);
  });
});
