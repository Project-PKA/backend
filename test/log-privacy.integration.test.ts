import { Writable } from 'node:stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KIND, SEED_IDS, SEED_LINK_TOKENS, uid } from '../src/db/seed.js';
import { serializeError } from '../src/http/log-serializers.js';
import { buildTestApp } from './helpers/app.js';
import { login, startWorld, type World } from './helpers/world.js';

/**
 * SECURITY.md: nenhum telefone, e-mail, CPF, token ou texto de lance em log. O teste sobe a API com o
 * log no nível mais detalhado, passa dado pessoal "marcado" por várias rotas (corpo, query e cabeçalho)
 * e falha se qualquer marca aparecer no que foi registrado.
 */

let world: World;

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await world.stop();
});

const A = SEED_IDS.storeA;
const MARKS = {
  phone: '5511977776666',
  name: 'Sentinela Marcada',
  email: 'sentinela.cliente@example.com',
  cpf: '52998224725',
  cpfMasked: '529.982.247-25',
  street: 'Rua Sentinela Marcada',
  invited: 'convidado.sentinela@example.com',
  search: 'Sentinela',
};

describe('o log da API não carrega dado pessoal', () => {
  it('rotas autenticadas, públicas e de erro, com query, corpo e cabeçalho marcados', async () => {
    const chunks: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk.toString('utf8'));
        done();
      },
    });
    await world.reseed();
    const server = await buildTestApp({
      pool: world.appPool,
      env: { LOG_LEVEL: 'trace' },
      logStream,
    });
    try {
      const owner = await login(server, 'dono@example.com');
      const secrets: string[] = [owner.accessToken];
      const call = (
        method: 'GET' | 'POST' | 'PATCH',
        url: string,
        payload?: unknown,
        headers = owner.headers(A),
      ) =>
        server.app.inject({
          method,
          url,
          headers,
          ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
        });

      // cadastro de cliente (corpo com telefone, e-mail, CPF e endereço) e buscas (query com nome e telefone)
      const created = await call('POST', '/v1/customers', {
        phone: MARKS.phone,
        name: MARKS.name,
        email: MARKS.email,
        cpf: MARKS.cpfMasked,
        address: {
          zip: '01310-100',
          street: MARKS.street,
          number: '10',
          city: 'São Paulo',
          state: 'SP',
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json<{ id: string }>().id;
      await call('GET', `/v1/customers?q=${encodeURIComponent(MARKS.search)}`);
      await call('GET', `/v1/customers?q=${MARKS.phone}`);
      await call('GET', `/v1/cards?q=${encodeURIComponent(MARKS.search)}`);
      await call('PATCH', `/v1/customers/${id}`, { address: { street: MARKS.street } });
      // erros 4xx com o dado marcado
      await call('POST', '/v1/customers', { phone: MARKS.phone, name: MARKS.name });
      await call('POST', '/v1/customers', {
        phone: '5511977770000',
        name: 'x',
        cpf: '111.111.111-11',
      });
      await call('GET', `/v1/customers/${id}`, undefined, {
        ...owner.headers(A),
        'x-store-id': 'lixo',
      });
      // equipe: convite por e-mail
      await call('POST', '/v1/team/invitations', { email: MARKS.invited });
      // lance
      const auction = await call('POST', '/v1/auctions', {
        card_id: uid(KIND.card, 12),
        type: 'FREE_BID',
        end_time: new Date(Date.now() + 3_600_000).toISOString(),
        initial_bid: '10.00',
        min_increment: '2.00',
      });
      await call('POST', `/v1/auctions/${auction.json<{ id: string }>().id}/bids`, {
        customer_id: uid(KIND.customer, 5),
        amount: '10.00',
      });
      // páginas públicas: o token vai no corpo e o CPF e o endereço também
      for (const url of ['/v1/public/settlement', '/v1/public/settlement/data']) {
        await server.app.inject({
          method: 'POST',
          url,
          payload: {
            token: SEED_LINK_TOKENS.settlement,
            cpf: MARKS.cpf,
            address: {
              zip: '01310100',
              street: MARKS.street,
              number: '1',
              city: 'SP',
              state: 'SP',
            },
            consent: { accepted: true, version: '2026-10-v1' },
          },
          remoteAddress: '198.51.100.7',
        });
      }
      await server.app.inject({
        method: 'POST',
        url: '/v1/public/consignor',
        payload: { token: SEED_LINK_TOKENS.consignor, key: '0000' },
        remoteAddress: '198.51.100.8',
      });
      secrets.push(SEED_LINK_TOKENS.settlement, SEED_LINK_TOKENS.consignor);

      const text = chunks.join('');
      // o teste só vale se o log existe e mostra o caminho (sem a query)
      expect(text.length).toBeGreaterThan(2000);
      expect(text).toContain('"url":"/v1/customers"');
      expect(text).not.toMatch(/"url":"[^"]*\?/);

      const forbidden = [
        ...Object.values(MARKS),
        'dono@example.com',
        'convidado@example.com',
        ...secrets,
      ];
      for (const mark of forbidden) {
        expect(text.toLowerCase(), `o log contém "${mark.slice(0, 12)}..."`).not.toContain(
          mark.toLowerCase(),
        );
      }
    } finally {
      await server.close();
    }
  });
});

describe('serializeError', () => {
  it('erro do banco não leva o valor que falhou (message, detail, where)', () => {
    const dbError = Object.assign(
      new Error('duplicate key value violates unique constraint "customers_store_phone_key"'),
      {
        name: 'error',
        severity: 'ERROR',
        code: '23505',
        detail: 'Key (store_id, phone)=(abc, 5511977776666) already exists.',
        where: 'valor 5511977776666',
        table: 'customers',
        constraint: 'customers_store_phone_key',
        routine: '_bt_check_unique',
      },
    );

    const serialized = JSON.stringify(serializeError(dbError));

    expect(serialized).not.toContain('5511977776666');
    expect(serialized).not.toContain('duplicate key');
    expect(JSON.parse(serialized)).toMatchObject({
      sqlstate: '23505',
      table: 'customers',
      constraint: 'customers_store_phone_key',
    });
  });

  it('erro comum mantém tipo, mensagem e pilha para depurar', () => {
    const serialized = serializeError(new TypeError('falhou algo interno'));
    expect(serialized).toMatchObject({ type: 'TypeError', message: 'falhou algo interno' });
    expect(serialized.stack).toContain('TypeError');
  });
});
