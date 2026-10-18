import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { MAX_PHOTOS_PER_CARD } from '../src/inventory/photos.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/** Fotos das cartas (#38): envio binário, validação pelo conteúdo, limite e acesso por loja. */

let world: World;
let app: TestApp | undefined;

const STAFF = 'funcionario@example.com';
const OWNER = 'dono@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const card = uid(KIND.card, 12);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 2),
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.alloc(4),
  Buffer.from('WEBP', 'latin1'),
  Buffer.alloc(32, 3),
]);

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

const upload = (
  server: TestApp,
  session: Session,
  storeId: string | undefined,
  body: Buffer,
  contentType = 'image/jpeg',
  cardId = card,
) =>
  server.app.inject({
    method: 'PUT',
    url: `/v1/cards/${cardId}/photos`,
    headers: { ...session.headers(storeId), 'content-type': contentType },
    payload: body,
  });

describe('envio (PUT /v1/cards/:id/photos)', () => {
  it('aceita JPEG, PNG e WebP, guarda no armazenamento e lista na carta', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const ids: string[] = [];
    for (const [body, type, ext] of [
      [JPEG, 'image/jpeg', 'jpg'],
      [PNG, 'image/png', 'png'],
      [WEBP, 'image/webp', 'webp'],
    ] as const) {
      const response = await upload(server, staff, A, body, type);
      expect(response.statusCode).toBe(201);
      const json = response.json<{ photo: string; photos: string[] }>();
      expect(json.photo).toMatch(new RegExp(`^[0-9a-f-]{36}\\.${ext}$`));
      ids.push(json.photo);
    }

    expect(new Set(server.storage.files.keys())).toEqual(
      new Set(ids.map((id) => `${A}/${card}/${id}`)),
    );
    const detail = await server.app.inject({
      method: 'GET',
      url: `/v1/cards/${card}`,
      headers: staff.headers(A),
    });
    expect(detail.json<{ card: { photos: string[] } }>().card.photos).toEqual(ids);

    const owner = await login(server, OWNER);
    const log = await server.app.inject({
      method: 'GET',
      url: '/v1/activity-log?limit=3',
      headers: owner.headers(A),
    });
    expect(log.json<{ items: { action: string }[] }>().items[0]?.action).toBe('card.photo_added');
  });

  it('descarta o Content-Type: quem manda um arquivo que não é imagem recebe 422', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const script = Buffer.from('<script>alert(1)</script>');
    const response = await upload(server, staff, A, script, 'image/jpeg');
    expect(response.statusCode).toBe(422);
    expect(response.json<{ code: string }>().code).toBe('PHOTO_INVALID');
    expect(server.storage.files.size).toBe(0);
  });

  it('recusa tipo de conteúdo que não é imagem e corpo acima de 5 MB', async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const text = await upload(server, staff, A, JPEG, 'text/plain');
    expect(text.statusCode).toBe(415);

    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
    const tooBig = await upload(server, staff, A, big);
    expect(tooBig.statusCode).toBe(413);
    expect(server.storage.files.size).toBe(0);
  });

  it(`limita a ${String(MAX_PHOTOS_PER_CARD)} fotos por carta, mesmo em envios simultâneos`, async () => {
    const server = await start();
    const staff = await login(server, STAFF);

    const results = await Promise.all(
      Array.from({ length: MAX_PHOTOS_PER_CARD + 3 }, () => upload(server, staff, A, JPEG)),
    );
    const accepted = results.filter((r) => r.statusCode === 201);
    const refused = results.filter((r) => r.statusCode === 409);
    expect(accepted).toHaveLength(MAX_PHOTOS_PER_CARD);
    expect(refused).toHaveLength(3);
    expect(refused[0]?.json<{ code: string }>().code).toBe('PHOTO_LIMIT_REACHED');
    expect(server.storage.files.size).toBe(MAX_PHOTOS_PER_CARD);
  });

  it('exige login, a loja da carta e a permissão de estoque', async () => {
    const server = await start();
    const anonymous = await server.app.inject({
      method: 'PUT',
      url: `/v1/cards/${card}/photos`,
      headers: { 'content-type': 'image/jpeg' },
      payload: JPEG,
    });
    expect(anonymous.statusCode).toBe(401);

    const staff = await login(server, STAFF);
    expect((await upload(server, staff, B, JPEG)).statusCode).toBe(403);

    // A carta é da loja A: pela loja B (onde o dono também atua) ela não existe.
    const owner = await login(server, OWNER);
    const crossed = await upload(server, owner, B, JPEG);
    expect([403, 404]).toContain(crossed.statusCode);
    expect(server.storage.files.size).toBe(0);

    await world.admin.query(
      `UPDATE store_members SET permissions = '{"can_manage_inventory": false}'::jsonb
        WHERE user_id = $1 AND store_id = $2`,
      [SEED_IDS.userStaff, A],
    );
    expect((await upload(server, staff, A, JPEG)).statusCode).toBe(403);
  });

  it('carta inexistente responde 404', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const response = await upload(
      server,
      staff,
      A,
      JPEG,
      'image/jpeg',
      '00000000-0000-4000-8000-000000000999',
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('leitura e remoção', () => {
  it('devolve a imagem com cabeçalhos seguros e só para quem é da loja', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const { photo } = (await upload(server, staff, A, PNG, 'image/png')).json<{ photo: string }>();

    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/cards/${card}/photos/${photo}`,
      headers: staff.headers(A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['cache-control']).toBe('private, max-age=3600');
    expect(response.rawPayload.equals(PNG)).toBe(true);

    const anonymous = await server.app.inject({
      method: 'GET',
      url: `/v1/cards/${card}/photos/${photo}`,
    });
    expect(anonymous.statusCode).toBe(401);
    const otherStore = await server.app.inject({
      method: 'GET',
      url: `/v1/cards/${card}/photos/${photo}`,
      headers: staff.headers(B),
    });
    expect(otherStore.statusCode).toBe(403);
  });

  it('não serve arquivo que a carta não lista nem id fora do formato', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const unknown = await server.app.inject({
      method: 'GET',
      url: `/v1/cards/${card}/photos/00000000-0000-4000-8000-000000000001.jpg`,
      headers: staff.headers(A),
    });
    expect(unknown.statusCode).toBe(404);
    const traversal = await server.app.inject({
      method: 'GET',
      url: `/v1/cards/${card}/photos/..%2F..%2Fetc%2Fpasswd`,
      headers: staff.headers(A),
    });
    expect([400, 404]).toContain(traversal.statusCode);
  });

  it('remove a foto da carta e do armazenamento', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const { photo } = (await upload(server, staff, A, JPEG)).json<{ photo: string }>();

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/v1/cards/${card}/photos/${photo}`,
      headers: staff.headers(A),
    });
    expect(removed.statusCode).toBe(204);
    expect(server.storage.files.size).toBe(0);

    const again = await server.app.inject({
      method: 'DELETE',
      url: `/v1/cards/${card}/photos/${photo}`,
      headers: staff.headers(A),
    });
    expect(again.statusCode).toBe(404);
  });

  it('excluir a carta apaga os arquivos dela', async () => {
    const server = await start();
    const owner = await login(server, OWNER);
    // A carta 12 pode ser excluída (disponível e sem leilão): confira antes de usar outra.
    const created = await server.app.inject({
      method: 'POST',
      url: '/v1/cards',
      headers: owner.headers(A),
      payload: { tcgdex_id: 'seed-003', language: 'PT', condition: 'NM', origin: 'OWN' },
    });
    const cardId = created.json<{ id: string }>().id;
    await upload(server, owner, A, JPEG, 'image/jpeg', cardId);
    expect(server.storage.files.size).toBe(1);

    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/v1/cards/${cardId}`,
      headers: owner.headers(A),
    });
    expect(removed.statusCode).toBe(204);
    expect(server.storage.files.size).toBe(0);
  });
});
