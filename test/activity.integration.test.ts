import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/** Log de atividades (GET /v1/activity-log): filtros por pessoa e ação e o autor na resposta. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const staffMemberId = uid(KIND.member, 3);

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
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  session: Session,
  storeId: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: session.headers(storeId),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

interface Entry {
  action: string;
  actor_user_id: string | null;
  actor: { id: string; name: string | null; email: string } | null;
}

const list = async (server: TestApp, session: Session, storeId: string, query = '') =>
  call(server, 'GET', `/v1/activity-log?limit=100${query}`, session, storeId);

const entries = async (server: TestApp, session: Session, storeId: string, query = '') =>
  (await list(server, session, storeId, query)).json<{ items: Entry[] }>().items;

const newCard = {
  tcgdex_id: 'seed-003',
  language: 'PT',
  condition: 'NM',
  origin: 'OWN',
};

describe('log de atividades: filtros e autor', () => {
  it('filtra por ação exata e por prefixo terminado em ponto', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    expect((await call(server, 'POST', '/v1/cards', staff, A, newCard)).statusCode).toBe(201);

    const exact = await entries(server, owner, A, '&action=card.created');
    expect(exact.map((e) => e.action)).toEqual(['card.created']);

    const prefix = await entries(server, owner, A, '&action=card.');
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.every((e) => e.action.startsWith('card.'))).toBe(true);

    // sem ponto final é ação exata: "card" sozinho não casa com nada
    expect(await entries(server, owner, A, '&action=card')).toEqual([]);
    // "_" não vira curinga
    expect(await entries(server, owner, A, '&action=card_created')).toEqual([]);
  });

  it('filtra por pessoa e mostra quem agiu', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    await call(server, 'POST', '/v1/cards', staff, A, newCard);

    const byStaff = await entries(server, owner, A, `&actor_user_id=${SEED_IDS.userStaff}`);
    expect(byStaff.map((e) => e.action)).toEqual(['card.created']);
    expect(byStaff[0]?.actor).toEqual({
      id: SEED_IDS.userStaff,
      name: expect.anything() as unknown,
      email: STAFF,
    });

    const byOwner = await entries(server, owner, A, `&actor_user_id=${SEED_IDS.userOwner}`);
    expect(byOwner.length).toBeGreaterThan(0);
    expect(byOwner.every((e) => e.actor_user_id === SEED_IDS.userOwner)).toBe(true);
    expect(byOwner.every((e) => e.actor?.email === OWNER)).toBe(true);

    const both = await entries(
      server,
      owner,
      A,
      `&actor_user_id=${SEED_IDS.userOwner}&action=invitation.sent`,
    );
    expect(both.map((e) => e.action)).toEqual(['invitation.sent']);
  });

  it('quem saiu da equipe continua no log, mas sem nome nem e-mail', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    await call(server, 'POST', '/v1/cards', staff, A, newCard);
    expect((await call(server, 'DELETE', `/v1/team/${staffMemberId}`, owner, A)).statusCode).toBe(
      204,
    );

    const created = (await entries(server, owner, A, '&action=card.created'))[0];
    expect(created?.actor_user_id).toBe(SEED_IDS.userStaff);
    expect(created?.actor).toBeNull();
    // o filtro por pessoa segue valendo para quem saiu
    expect(await entries(server, owner, A, `&actor_user_id=${SEED_IDS.userStaff}`)).toHaveLength(1);
  });

  it('acesso cruzado: nunca devolve o log de outra loja nem o autor de lá', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    await call(server, 'POST', '/v1/cards', staff, A, newCard);

    // o dono também é proprietário da loja B; a pessoa do filtro não tem ação lá
    const inB = await entries(server, owner, B, `&actor_user_id=${SEED_IDS.userStaff}`);
    expect(inB).toEqual([]);
    const allB = await entries(server, owner, B, '&action=card.created');
    expect(allB).toEqual([]);

    // funcionário não lê o log, com ou sem filtro
    expect((await list(server, staff, A, '&action=card.')).statusCode).toBe(403);
    // loja errada no header: 403 antes de qualquer filtro
    expect((await list(server, staff, B)).statusCode).toBe(403);
  });

  it('valida os filtros', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    for (const query of ['&actor_user_id=nao-e-uuid', '&action=Card.Created', '&action=a%20b']) {
      expect((await list(server, owner, A, query)).statusCode).toBe(400);
    }
    expect((await list(server, owner, A, `&action=${'a'.repeat(65)}`)).statusCode).toBe(400);
  });
});
