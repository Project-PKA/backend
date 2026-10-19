import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SEED_IDS } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/** Modelos das mensagens do bot por loja (shared#33). Postgres real, papel `app_api`. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const OTHER_OWNER = 'outro-dono@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;

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
  method: 'GET' | 'PUT' | 'DELETE',
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

interface TemplateJson {
  key: string;
  placeholders: string[];
  default_body: string;
  custom_body: string | null;
}

const list = async (server: TestApp, session: Session, store: string) =>
  (await call(server, 'GET', '/v1/store/message-templates', session, store)).json<{
    items: TemplateJson[];
  }>().items;

describe('modelos de mensagem (/v1/store/message-templates)', () => {
  it('lista todas as chaves com o padrão e sem texto da loja', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const items = await list(server, staff, A);

    expect(items.map((item) => item.key)).toEqual([
      'card_opened',
      'bid_too_low',
      'invalid_amount',
      'not_started',
      'ended',
      'not_active',
      'ceiling_reached',
      'auction_won',
      'auction_unsold',
    ]);
    expect(items.every((item) => item.custom_body === null)).toBe(true);
    expect(items[0]?.placeholders).toContain('short_code');
  });

  it('o proprietário define e restaura; o funcionário só lê', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const staff = await login(server, STAFF);
    const url = '/v1/store/message-templates/auction_won';

    const denied = await call(server, 'PUT', url, staff, A, { body: 'Oi {winner}' });
    expect(denied.statusCode).toBe(403);

    const set = await call(server, 'PUT', url, owner, A, {
      body: '  Parabéns {winner}! {card} por {amount}  ',
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json<TemplateJson>().custom_body).toBe('Parabéns {winner}! {card} por {amount}');
    const won = (await list(server, staff, A)).find((item) => item.key === 'auction_won');
    expect(won?.custom_body).toBe('Parabéns {winner}! {card} por {amount}');

    const log = await call(server, 'GET', '/v1/activity-log?limit=1', owner, A);
    expect(log.json<{ items: { action: string; details: unknown }[] }>().items[0]).toMatchObject({
      action: 'message_template.updated',
      details: { key: 'auction_won' },
    });

    const reset = await call(server, 'DELETE', url, owner, A);
    expect(reset.statusCode).toBe(200);
    expect(reset.json<TemplateJson>().custom_body).toBeNull();
    const rows = await world.admin.query('SELECT 1 FROM store_message_templates');
    expect(rows.rowCount).toBe(0);
  });

  it('recusa marcador desconhecido, chave inexistente e texto vazio', async () => {
    const server = await start();
    const owner = await login(server, OWNER);

    const unknown = await call(server, 'PUT', '/v1/store/message-templates/bid_too_low', owner, A, {
      body: 'Olá {winner}',
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json()).toMatchObject({ code: 'MESSAGE_TEMPLATE_PLACEHOLDER_UNKNOWN' });
    const badKey = await call(server, 'PUT', '/v1/store/message-templates/xyz', owner, A, {
      body: 'x',
    });
    expect(badKey.statusCode).toBe(400);
    const blank = await call(server, 'PUT', '/v1/store/message-templates/ended', owner, A, {
      body: '   ',
    });
    expect(blank.statusCode).toBe(400);
  });

  it('cada loja vê só os seus textos', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    const other = await login(server, OTHER_OWNER);
    await call(server, 'PUT', '/v1/store/message-templates/ended', owner, A, { body: 'Da loja A' });

    const own = (await list(server, owner, B)).find((item) => item.key === 'ended');
    expect(own?.custom_body).toBeNull();
    const crossed = await call(server, 'GET', '/v1/store/message-templates', other, A);
    expect(crossed.statusCode).toBe(403);
  });
});
