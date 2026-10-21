import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, uid } from '../src/db/seed.js';
import { buildTestApp, type TestApp } from './helpers/app.js';
import { login, startWorld, type Session, type World } from './helpers/world.js';

/** POST /v1/customers/:id/anonymize: LGPD mínima (ADR 0019). Postgres real, papel app_api. */

let world: World;
let app: TestApp | undefined;

const OWNER = 'dono@example.com';
const STAFF = 'funcionario@example.com';
const A = SEED_IDS.storeA;
const B = SEED_IDS.storeB;
const customer = (n: number) => uid(KIND.customer, n);

const NAME = 'Fulana de Tal Silva';
const EMAIL = 'fulana.silva@example.com';
const RECEIPT = '11111111-1111-4111-8111-111111111111.png';

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
  storeId: string,
  payload?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: session.headers(storeId),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

interface Subject {
  id: string;
  phone: string;
  cpfDigits: string;
  settlementId: string;
}

/** Escolhe o cliente do acerto que o seed já liga a um link público e dá a ele nome e e-mail marcantes. */
async function pickSubject(): Promise<Subject> {
  const found = await world.admin.query<{ id: string; phone: string; settlement_id: string }>(
    `SELECT c.id, c.phone, s.id AS settlement_id
       FROM public_links l
       JOIN settlements s ON s.id = l.settlement_id
       JOIN customers c ON c.id = s.customer_id
      WHERE l.kind = 'SETTLEMENT' AND l.store_id = $1 LIMIT 1`,
    [A],
  );
  const row = found.rows[0];
  if (row === undefined) throw new Error('o seed precisa de um acerto com link público');
  await world.admin.query('UPDATE customers SET name = $2, email = $3 WHERE id = $1', [
    row.id,
    NAME,
    EMAIL,
  ]);
  const cpf = await world.admin.query<{ cpf_last2: string | null }>(
    'SELECT cpf_last2 FROM customers WHERE id = $1',
    [row.id],
  );
  expect(cpf.rows[0]?.cpf_last2).not.toBeNull();
  return { id: row.id, phone: row.phone, cpfDigits: row.phone, settlementId: row.settlement_id };
}

const TABLES = [
  'customers',
  'bids',
  'lgpd_consents',
  'settlements',
  'settlement_items',
  'public_links',
  'activity_log',
  'notifications',
];

/** Texto de todas as linhas ligadas ao cliente, para procurar dado pessoal que sobrou. */
async function dumpOf(subject: Subject): Promise<string> {
  const parts: string[] = [];
  for (const table of TABLES) {
    const result = await world.admin.query<{ row: string }>(
      `SELECT to_jsonb(t)::text AS row FROM ${table} t WHERE t.store_id = $1`,
      [A],
    );
    parts.push(...result.rows.map((r) => r.row));
  }
  parts.push(subject.id);
  return parts.join('\n');
}

const totals = async (customerId: string) => {
  const result = await world.admin.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM bids WHERE customer_id = $1) AS bids,
       (SELECT coalesce(sum(amount), 0) FROM bids WHERE customer_id = $1) AS bid_sum,
       (SELECT count(*) FROM settlements WHERE customer_id = $1) AS settlements,
       (SELECT coalesce(sum(total_amount), 0) FROM settlements WHERE customer_id = $1) AS settled,
       (SELECT coalesce(sum(total_amount), 0) FROM settlements WHERE store_id = $2) AS store_settled,
       (SELECT count(*) FROM auctions a JOIN bids b ON b.id = a.winning_bid_id WHERE b.customer_id = $1) AS wins`,
    [customerId, A],
  );
  return result.rows[0];
};

describe('anonimização (POST /v1/customers/:id/anonymize)', () => {
  it('apaga o dado pessoal em todas as tabelas e mantém o histórico somável', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const subject = await pickSubject();

    // comprovante guardado, para conferir que o arquivo também sai
    await world.admin.query(`UPDATE settlements SET receipt_file = $2 WHERE id = $1`, [
      subject.settlementId,
      RECEIPT,
    ]);
    await server.storage.put(`receipts/${RECEIPT}`, Buffer.from('imagem'));
    await world.admin.query(
      `INSERT INTO lgpd_consents (store_id, customer_id, settlement_id, text_version, ip)
       VALUES ($1, $2, $3, 'v1', '203.0.113.7')`,
      [A, subject.id, subject.settlementId],
    );
    const before = await totals(subject.id);
    expect(Number(before?.['bids'])).toBeGreaterThan(0);
    const dirty = await dumpOf(subject);
    for (const needle of [NAME, EMAIL, subject.phone, RECEIPT, '203.0.113.7']) {
      expect(dirty, needle).toContain(needle);
    }

    const response = await call(server, 'POST', `/v1/customers/${subject.id}/anonymize`, staff, A);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: subject.id,
      kind: 'VISITOR',
      email: null,
      cpf_masked: null,
      is_blacklisted: true,
      address: { zip: null, street: null, number: null, comp: null, city: null, state: null },
    });
    expect(response.json<{ anonymized_at: string | null }>().anonymized_at).not.toBeNull();
    for (const needle of [NAME, EMAIL, subject.phone]) expect(response.body).not.toContain(needle);

    // nenhum dado pessoal sobra no banco
    const clean = await dumpOf(subject);
    for (const needle of [NAME, EMAIL, subject.phone, RECEIPT, '203.0.113.7']) {
      expect(clean, needle).not.toContain(needle);
    }
    const row = await world.admin.query<Record<string, unknown>>(
      `SELECT name, phone, email, cpf, cpf_last2, cpf_key_hash, address_zip, address_street,
              address_number, address_comp, address_city, address_state, is_blacklisted
         FROM customers WHERE id = $1`,
      [subject.id],
    );
    expect(row.rows[0]).toEqual({
      name: 'Cliente anonimizado',
      phone: `anon-${subject.id}`,
      email: null,
      cpf: null,
      cpf_last2: null,
      cpf_key_hash: null,
      address_zip: null,
      address_street: null,
      address_number: null,
      address_comp: null,
      address_city: null,
      address_state: null,
      is_blacklisted: true,
    });
    const messages = await world.admin.query<{ raw_whatsapp_message: string }>(
      'SELECT DISTINCT raw_whatsapp_message FROM bids WHERE customer_id = $1',
      [subject.id],
    );
    expect(messages.rows).toEqual([{ raw_whatsapp_message: '[removido]' }]);
    const links = await world.admin.query<{ revoked_at: Date | null }>(
      'SELECT revoked_at FROM public_links WHERE settlement_id = $1 OR customer_id = $2',
      [subject.settlementId, subject.id],
    );
    expect(links.rows.length).toBeGreaterThan(0);
    expect(links.rows.every((l) => l.revoked_at !== null)).toBe(true);
    expect(server.storage.files.has(`receipts/${RECEIPT}`)).toBe(false);

    // o histórico segue consistente e somável: lances, acertos, vitórias e o total da loja
    expect(await totals(subject.id)).toEqual(before);

    // o log guarda só o id
    const owner = await login(server, OWNER);
    const log = await call(server, 'GET', '/v1/activity-log?limit=100', owner, A);
    const entry = log
      .json<{
        items: { action: string; target_id: string | null; details: Record<string, unknown> }[];
      }>()
      .items.find((e) => e.action === 'customer.anonymized');
    expect(entry).toMatchObject({ target_id: subject.id, details: {} });
  });

  it('repetir é inofensivo e não grava outro registro no log', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const first = await call(server, 'POST', `/v1/customers/${customer(5)}/anonymize`, staff, A);
    const again = await call(server, 'POST', `/v1/customers/${customer(5)}/anonymize`, staff, A);

    expect(first.statusCode).toBe(200);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ anonymized_at: string }>().anonymized_at).toBe(
      first.json<{ anonymized_at: string }>().anonymized_at,
    );
    const count = await world.admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM activity_log WHERE action = 'customer.anonymized'",
    );
    expect(Number(count.rows[0]?.n)).toBe(1);
  });

  it('anonimizado não recebe lance, não se edita e não ganha link de consignador', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    // cliente 2 é consignador com CPF, então teria direito ao link antes
    expect(
      (await call(server, 'POST', `/v1/customers/${customer(2)}/consignor-link`, staff, A, {}))
        .statusCode,
    ).toBe(201);
    await call(server, 'POST', `/v1/customers/${customer(2)}/anonymize`, staff, A);

    const created = await call(server, 'POST', '/v1/auctions', staff, A, {
      card_id: uid(KIND.card, 12),
      type: 'FREE_BID',
      end_time: new Date(Date.now() + 3_600_000).toISOString(),
      initial_bid: '10.00',
      min_increment: '2.00',
    });
    const bid = await call(
      server,
      'POST',
      `/v1/auctions/${created.json<{ id: string }>().id}/bids`,
      staff,
      A,
      { customer_id: customer(2), amount: '10.00' },
    );
    expect(bid.statusCode).toBe(422);
    expect(bid.json()).toMatchObject({ code: 'BID_CUSTOMER_BLACKLISTED' });

    const edit = await call(server, 'PATCH', `/v1/customers/${customer(2)}`, staff, A, {
      name: 'Outra Pessoa',
      cpf: '529.982.247-25',
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json()).toMatchObject({ code: 'CUSTOMER_ANONYMIZED' });
    const unmark = await call(server, 'DELETE', `/v1/customers/${customer(2)}/blacklist`, staff, A);
    expect(unmark.statusCode).toBe(409);
    expect(unmark.json()).toMatchObject({ code: 'CUSTOMER_ANONYMIZED' });
    const mark = await call(server, 'POST', `/v1/customers/${customer(2)}/blacklist`, staff, A, {
      reason: 'x',
    });
    expect(mark.statusCode).toBe(409);

    const link = await call(
      server,
      'POST',
      `/v1/customers/${customer(2)}/consignor-link`,
      staff,
      A,
      {},
    );
    expect(link.statusCode).toBe(422);
    expect(link.json()).toMatchObject({ code: 'CONSIGNOR_CPF_REQUIRED' });
  });

  it('o telefone antigo fica livre para um novo cadastro', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const phone = (
      await world.admin.query<{ phone: string }>('SELECT phone FROM customers WHERE id = $1', [
        customer(30),
      ])
    ).rows[0]?.phone;
    await call(server, 'POST', `/v1/customers/${customer(30)}/anonymize`, staff, A);

    const again = await call(server, 'POST', '/v1/customers', staff, A, {
      phone,
      name: 'Nova Pessoa',
    });
    expect(again.statusCode, again.body).toBe(201);
  });

  it('acesso cruzado: não anonimiza cliente de outra loja; exige a permissão e o login', async () => {
    const server = await start();
    const staff = await login(server, STAFF);
    const owner = await login(server, OWNER);

    // cliente 101 é da loja B: 404 com o contexto de A, e nada muda
    const foreign = await call(
      server,
      'POST',
      `/v1/customers/${customer(101)}/anonymize`,
      owner,
      A,
    );
    expect(foreign.statusCode).toBe(404);
    const inB = await world.admin.query<{ name: string; anonymized_at: Date | null }>(
      'SELECT name, anonymized_at FROM customers WHERE id = $1',
      [customer(101)],
    );
    expect(inB.rows[0]?.anonymized_at).toBeNull();
    expect(inB.rows[0]?.name).toBe('Cliente B1');
    // o funcionário nem participa da loja B
    expect(
      (await call(server, 'POST', `/v1/customers/${customer(101)}/anonymize`, staff, B)).statusCode,
    ).toBe(403);
    // o dono de B anonimiza o dele, e a loja A não é tocada
    expect(
      (await call(server, 'POST', `/v1/customers/${customer(101)}/anonymize`, owner, B)).statusCode,
    ).toBe(200);
    const inA = await world.admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM customers WHERE store_id = $1 AND anonymized_at IS NOT NULL',
      [A],
    );
    expect(Number(inA.rows[0]?.n)).toBe(0);

    await world.admin.query(
      `UPDATE store_members SET permissions = '{"can_manage_customers": false}'::jsonb
        WHERE user_id = $1 AND store_id = $2`,
      [SEED_IDS.userStaff, A],
    );
    expect(
      (await call(server, 'POST', `/v1/customers/${customer(5)}/anonymize`, staff, A)).statusCode,
    ).toBe(403);
    const anonymous = await server.app.inject({
      method: 'POST',
      url: `/v1/customers/${customer(5)}/anonymize`,
      headers: { 'x-store-id': A },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
