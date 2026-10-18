import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, SEED_LINK_TOKENS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type World } from './helpers/world.js';

/** Comprovante do "já paguei" (#53 / shared#25): rota pública por link e download pela loja. */

let world: World;
let app: TestApp | undefined;

const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const PENDING = uid(KIND.settlement, 2);
const PAID = uid(KIND.settlement, 1);
const UNKNOWN_TOKEN = 'Z'.repeat(43);

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(80, 7),
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
  token: string,
  body: Buffer,
  contentType = 'image/png',
  ip = '203.0.113.80',
) =>
  server.app.inject({
    method: 'PUT',
    url: '/v1/public/settlement/receipt',
    headers: { 'content-type': contentType, 'x-public-token': token },
    payload: body,
    remoteAddress: ip,
  });

const pageOf = (server: TestApp) =>
  server.app.inject({
    method: 'POST',
    url: '/v1/public/settlement',
    payload: { token: SEED_LINK_TOKENS.settlement },
    remoteAddress: '203.0.113.81',
  });

describe('envio pelo comprador (PUT /v1/public/settlement/receipt)', () => {
  it('guarda o comprovante, registra o aviso uma vez e notifica a loja sem marcar como pago', async () => {
    const server = await start();

    const response = await upload(server, SEED_LINK_TOKENS.settlement, PNG);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: 'OK' });

    const [key] = [...server.storage.files.keys()];
    expect(key).toMatch(/^receipts\/[0-9a-f-]{36}\.png$/);

    const row = await world.admin.query<{ status: string; claimed: Date | null; file: string }>(
      'SELECT status, payment_claimed_at AS claimed, receipt_file AS file FROM settlements WHERE id = $1',
      [PENDING],
    );
    expect(row.rows[0]?.status).toBe('PENDING');
    expect(row.rows[0]?.claimed).not.toBeNull();
    expect(key).toBe(`receipts/${row.rows[0]?.file ?? ''}`);
    expect(
      (await world.admin.query("SELECT 1 FROM notifications WHERE kind = 'PAYMENT_CLAIMED'"))
        .rowCount,
    ).toBe(1);

    const page = await pageOf(server);
    expect(page.json<{ receipt_sent: boolean }>().receipt_sent).toBe(true);
  });

  it('só aceita um comprovante por acerto e não deixa arquivo sobrando', async () => {
    const server = await start();
    await upload(server, SEED_LINK_TOKENS.settlement, PNG);

    const again = await upload(server, SEED_LINK_TOKENS.settlement, PNG);
    expect(again.json()).toEqual({ result: 'RECEIPT_EXISTS' });
    expect(server.storage.files.size).toBe(1);
    expect(
      (await world.admin.query("SELECT 1 FROM notifications WHERE kind = 'PAYMENT_CLAIMED'"))
        .rowCount,
    ).toBe(1);
  });

  it('acerto já pago: ALREADY_PAID e nada fica no armazenamento', async () => {
    const server = await start();
    await world.admin.query(
      `UPDATE settlements SET status = 'PAID', paid_at = now() WHERE id = $1`,
      [PENDING],
    );
    const response = await upload(server, SEED_LINK_TOKENS.settlement, PNG);
    expect(response.json()).toEqual({ result: 'ALREADY_PAID' });
    expect(server.storage.files.size).toBe(0);
  });

  it('link inválido, de outro tipo ou revogado: 404 igual e o arquivo é apagado', async () => {
    const server = await start();
    const responses = await Promise.all([
      upload(server, UNKNOWN_TOKEN, PNG, 'image/png', '198.51.100.1'),
      upload(server, SEED_LINK_TOKENS.consignor, PNG, 'image/png', '198.51.100.2'),
      upload(server, SEED_LINK_TOKENS.revokedSettlement, PNG, 'image/png', '198.51.100.3'),
    ]);
    expect(new Set(responses.map((r) => r.statusCode))).toEqual(new Set([404]));
    expect(new Set(responses.map((r) => r.body)).size).toBe(1);
    expect(server.storage.files.size).toBe(0);
    const row = await world.admin.query('SELECT 1 FROM settlements WHERE receipt_file IS NOT NULL');
    expect(row.rowCount).toBe(0);
  });

  it('descarta o Content-Type: arquivo que não é imagem recebe 422', async () => {
    const server = await start();
    const response = await upload(server, SEED_LINK_TOKENS.settlement, Buffer.from('<html>'));
    expect(response.statusCode).toBe(422);
    expect(response.json<{ code: string }>().code).toBe('RECEIPT_INVALID');
    expect(server.storage.files.size).toBe(0);
  });

  it('recusa tipo que não é imagem (415), corpo acima de 5 MB (413) e token fora do formato (400)', async () => {
    const server = await start();
    expect((await upload(server, SEED_LINK_TOKENS.settlement, PNG, 'text/plain')).statusCode).toBe(
      415,
    );
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
    expect((await upload(server, SEED_LINK_TOKENS.settlement, big)).statusCode).toBe(413);
    expect((await upload(server, 'curto', PNG)).statusCode).toBe(400);
    expect(server.storage.files.size).toBe(0);
  });
});

describe('download pela loja (GET /v1/settlements/:id/receipt)', () => {
  it('devolve os mesmos bytes, só para a loja do acerto, e o detalhe mostra has_receipt', async () => {
    const server = await start();
    await upload(server, SEED_LINK_TOKENS.settlement, PNG);
    const staff = await login(server, STAFF);

    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/settlements/${PENDING}/receipt`,
      headers: staff.headers(A),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.rawPayload.equals(PNG)).toBe(true);

    const detail = await server.app.inject({
      method: 'GET',
      url: `/v1/settlements/${PENDING}`,
      headers: staff.headers(A),
    });
    expect(detail.json<{ has_receipt: boolean }>().has_receipt).toBe(true);

    const anonymous = await server.app.inject({
      method: 'GET',
      url: `/v1/settlements/${PENDING}/receipt`,
    });
    expect(anonymous.statusCode).toBe(401);
    const otherStore = await server.app.inject({
      method: 'GET',
      url: `/v1/settlements/${PENDING}/receipt`,
      headers: staff.headers(B),
    });
    expect(otherStore.statusCode).toBe(403);
  });

  it('sem comprovante responde 404', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const response = await server.app.inject({
      method: 'GET',
      url: `/v1/settlements/${PAID}/receipt`,
      headers: staff.headers(A),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json<{ code: string }>().code).toBe('RECEIPT_NOT_FOUND');
  });

  it('desfazer o acerto apaga o comprovante', async () => {
    const server = await start();
    await upload(server, SEED_LINK_TOKENS.settlement, PNG);
    const staff = await login(server, STAFF);
    const removed = await server.app.inject({
      method: 'DELETE',
      url: `/v1/settlements/${PENDING}`,
      headers: staff.headers(A),
    });
    expect(removed.statusCode).toBe(204);
    expect(server.storage.files.size).toBe(0);
  });
});
