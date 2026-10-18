import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { syncCatalog } from '../src/catalog/sync.js';
import type { CardBrief, SetBrief, TcgdexClient } from '../src/catalog/tcgdex.js';
import { createDb } from '../src/db/context.js';
import { SEED_IDS } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type World } from './helpers/world.js';

/** Sprint 03: sync do catálogo (TCGdex falso), busca e detalhe com raridade. Postgres real. */

let world: World;
let app: TestApp | undefined;

const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;

interface FakeData {
  sets: Record<string, SetBrief[]>;
  cards: Record<string, CardBrief[]>;
  rarity?: Record<string, string>;
  failDetail?: boolean;
  detailCalls?: string[];
}

function fakeClient(data: FakeData): TcgdexClient {
  return {
    listSets: (language) => Promise.resolve({ sets: data.sets[language] ?? [], skipped: 0 }),
    listCards: (language) => Promise.resolve({ cards: data.cards[language] ?? [], skipped: 2 }),
    getCard: (_language, id) => {
      data.detailCalls?.push(id);
      if (data.failDetail === true) return Promise.reject(new Error('TCGdex fora do ar'));
      const rarity = data.rarity?.[id];
      return Promise.resolve(rarity === undefined ? null : { id, rarity });
    },
  };
}

const card = (id: string, localId: string, name: string): CardBrief => ({
  id,
  localId,
  name,
  image: `https://assets.tcgdex.net/en/x/${id}`,
});

const baseData = (): FakeData => ({
  sets: {
    en: [
      { id: 'zz01', name: 'Test Set' },
      { id: 'zz01b', name: 'Test Set B' },
    ],
    pt: [{ id: 'zz01', name: 'Coleção de Teste' }],
  },
  cards: {
    en: [
      card('zz01-006', '006', 'Flabébé'),
      card('zz01-007', '007', 'Mr. Mime'),
      card('zz01b-001', '001', '100%_Pure'),
    ],
    pt: [card('zz01-006', '006', 'Flabébé PT'), card('zz01-007', '007', 'Mímico')],
  },
  rarity: { 'zz01-006': 'Rare Holo' },
  detailCalls: [],
});

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

const syncWith = (data: FakeData, minRatio?: number) =>
  syncCatalog({
    db: createDb(world.appPool),
    client: fakeClient(data),
    languages: ['en', 'pt'],
    ...(minRatio === undefined ? {} : { minRatio }),
  });

async function search(server: TestApp, q: string) {
  const session = await login(server, STAFF);
  const response = await server.app.inject({
    method: 'GET',
    url: `/v1/catalog/search?q=${encodeURIComponent(q)}`,
    headers: session.headers(A),
  });
  return {
    response,
    ids: (response.json<{ items?: { id: string }[] }>().items ?? [])
      .map((i) => i.id)
      .filter((id) => id.startsWith('zz01'))
      .sort((a, b) => a.localeCompare(b)),
  };
}

describe('sync do catálogo', () => {
  it('insere, junta idiomas e é idempotente', async () => {
    const data = baseData();

    const first = await syncWith(data);
    expect(first).toMatchObject({ seen: 3, inserted: 3, updated: 0 });
    expect(first.skipped).toBe(4);

    const second = await syncWith(data);
    expect(second).toMatchObject({ seen: 3, inserted: 0, updated: 0 });

    const { rows } = await world.admin.query<{
      name: string;
      set_name: string;
      set_id: string;
      raw_data: { names: Record<string, string> };
    }>(`SELECT name, set_name, set_id, raw_data FROM tcgdex_catalog WHERE id = 'zz01-006'`);
    expect(rows[0]).toMatchObject({ name: 'Flabébé', set_name: 'Test Set', set_id: 'zz01' });
    expect(rows[0]?.raw_data.names).toEqual({ en: 'Flabébé', pt: 'Flabébé PT' });
  });

  it('usa o maior prefixo como coleção', async () => {
    await syncWith(baseData());
    const { rows } = await world.admin.query<{ set_id: string }>(
      `SELECT set_id FROM tcgdex_catalog WHERE id = 'zz01b-001'`,
    );
    expect(rows[0]?.set_id).toBe('zz01b');
  });

  it('atualiza o que mudou e preserva a raridade já buscada', async () => {
    const data = baseData();
    await syncWith(data);
    await world.admin.query(
      `UPDATE tcgdex_catalog SET raw_data = raw_data || '{"rarity":"Rare Holo"}'::jsonb WHERE id = 'zz01-006'`,
    );

    data.cards['en'] = [card('zz01-006', '006', 'Flabébé Renomeada')];
    data.cards['pt'] = [];
    const summary = await syncWith(data, 0);

    expect(summary.updated).toBe(1);
    const { rows } = await world.admin.query<{ name: string; raw_data: { rarity?: string } }>(
      `SELECT name, raw_data FROM tcgdex_catalog WHERE id = 'zz01-006'`,
    );
    expect(rows[0]?.name).toBe('Flabébé Renomeada');
    expect(rows[0]?.raw_data.rarity).toBe('Rare Holo');
    const kept = await world.admin.query(`SELECT 1 FROM tcgdex_catalog WHERE id = 'zz01-007'`);
    expect(kept.rowCount).toBe(1);
  });

  it('registra a execução, com sucesso e com falha', async () => {
    await world.admin.query('TRUNCATE catalog_sync_runs');
    await syncWith(baseData());
    await expect(
      syncCatalog({
        db: createDb(world.appPool),
        client: {
          ...fakeClient(baseData()),
          listCards: () => Promise.reject(new Error('TCGdex respondeu 503')),
        },
        languages: ['en'],
      }),
    ).rejects.toThrow('503');

    const { rows } = await world.admin.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM catalog_sync_runs ORDER BY started_at, id`,
    );
    expect(rows.map((r) => r.status)).toEqual(['OK', 'FAILED']);
    expect(rows[1]?.error).toContain('503');
  });

  it('recusa resposta suspeita (muito menor que o catálogo) sem gravar nada', async () => {
    await world.admin.query(
      `INSERT INTO tcgdex_catalog (id, name, card_number, set_name, raw_data)
       SELECT 'bulk-' || g, 'Carta ' || g, g::text, 'Bulk', '{}'::jsonb FROM generate_series(1, 1200) g`,
    );

    await expect(syncWith(baseData())).rejects.toThrow('suspeita');

    const { rows } = await world.admin.query<{ n: string }>(
      `SELECT count(*) AS n FROM tcgdex_catalog WHERE id LIKE 'zz01%'`,
    );
    expect(rows[0]?.n).toBe('0');
  });
});

describe('busca no catálogo (GET /v1/catalog/search)', () => {
  beforeEach(async () => {
    await syncWith(baseData());
  });

  it('exige login e loja', async () => {
    app = await buildTestApp({ pool: world.appPool });
    const anonymous = await app.app.inject({ method: 'GET', url: '/v1/catalog/search?q=flab' });
    expect(anonymous.statusCode).toBe(401);

    const session = await login(app, STAFF);
    const noStore = await app.app.inject({
      method: 'GET',
      url: '/v1/catalog/search?q=flab',
      headers: session.headers(),
    });
    expect(noStore.statusCode).toBeGreaterThanOrEqual(400);
    expect(noStore.statusCode).toBeLessThan(500);
  });

  it('acha sem acento e sem diferença de maiúsculas', async () => {
    app = await buildTestApp({ pool: world.appPool });
    expect((await search(app, 'FLABEBE')).ids).toEqual(['zz01-006']);
    expect((await search(app, 'flabébé')).ids).toEqual(['zz01-006']);
  });

  it('acha pelo nome em outro idioma, pelo número (com ou sem zeros) e pela coleção', async () => {
    app = await buildTestApp({ pool: world.appPool });
    expect((await search(app, 'mimico')).ids).toEqual(['zz01-007']);
    expect((await search(app, 'flabebe 006')).ids).toEqual(['zz01-006']);
    expect((await search(app, 'mime 7')).ids).toEqual(['zz01-007']);
    expect((await search(app, 'colecao de teste')).ids).toEqual(['zz01-006', 'zz01-007']);
  });

  it('trata % e _ como texto, não como curinga', async () => {
    app = await buildTestApp({ pool: world.appPool });
    expect((await search(app, '100%')).ids).toEqual(['zz01b-001']);
    expect((await search(app, '%%')).ids).toEqual([]);
    expect((await search(app, '__')).ids).toEqual([]);
  });

  it('entrada curta devolve lista vazia; limite respeitado; q é obrigatório', async () => {
    app = await buildTestApp({ pool: world.appPool });
    expect((await search(app, 'f')).ids).toEqual([]);

    const session = await login(app, STAFF);
    const limited = await app.app.inject({
      method: 'GET',
      url: '/v1/catalog/search?q=test&limit=1',
      headers: session.headers(A),
    });
    expect(limited.json<{ items: unknown[] }>().items).toHaveLength(1);

    const missing = await app.app.inject({
      method: 'GET',
      url: '/v1/catalog/search',
      headers: session.headers(A),
    });
    expect(missing.statusCode).toBe(400);
  });
});

describe('detalhe da carta (GET /v1/catalog/cards/:id)', () => {
  const get = async (server: TestApp, id: string) => {
    const session = await login(server, STAFF);
    return server.app.inject({
      method: 'GET',
      url: `/v1/catalog/cards/${encodeURIComponent(id)}`,
      headers: session.headers(A),
    });
  };

  it('busca a raridade na primeira vez e guarda para as próximas', async () => {
    const data = baseData();
    await syncWith(data);
    app = await buildTestApp({ pool: world.appPool, tcgdex: fakeClient(data) });

    const first = await get(app, 'zz01-006');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      id: 'zz01-006',
      rarity: 'Rare Holo',
      set_name: 'Test Set',
      number: '006',
      image_url: 'https://assets.tcgdex.net/en/x/zz01-006/low.webp',
    });

    data.detailCalls = [];
    const second = await get(app, 'zz01-006');
    expect(second.json<{ rarity: string }>().rarity).toBe('Rare Holo');
    expect(data.detailCalls).toEqual([]);
  });

  it('se o TCGdex falhar, devolve a carta sem raridade', async () => {
    const data = baseData();
    await syncWith(data);
    data.failDetail = true;
    app = await buildTestApp({ pool: world.appPool, tcgdex: fakeClient(data) });

    const response = await get(app, 'zz01-007');
    expect(response.statusCode).toBe(200);
    expect(response.json<{ rarity: unknown }>().rarity).toBeNull();
  });

  it('404 para carta inexistente ou id inválido', async () => {
    app = await buildTestApp({ pool: world.appPool, tcgdex: fakeClient(baseData()) });
    expect((await get(app, 'nao-existe')).statusCode).toBe(404);
    expect((await get(app, "x'; drop table users;--")).statusCode).toBe(404);
  });
});
