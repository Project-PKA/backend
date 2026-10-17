import type pg from 'pg';
import { expect } from 'vitest';

import { createPool } from '../../src/db/client.js';
import { migrateUp } from '../../src/db/migrator.js';
import { provisionLoginRole } from '../../src/db/roles.js';
import { seedDatabase } from '../../src/db/seed.js';
import type { TestApp } from './app.js';
import { resetDatabase, startDatabase, type TestDatabase } from './database.js';

/** Banco de teste com o schema, o seed e o papel `app_api` (o do Backend em execução, sem BYPASSRLS). */
export interface World {
  database: TestDatabase;
  /** Superusuário: só para preparar e conferir o banco. */
  admin: pg.Pool;
  /** Papel `app_api`: o que a API usa e que sofre o RLS. */
  appPool: pg.Pool;
  stop: () => Promise<void>;
  reseed: () => Promise<void>;
}

export async function startWorld(): Promise<World> {
  const database = await startDatabase();
  await resetDatabase(database.pool);
  await migrateUp(database.pool, 'migrations');
  await provisionLoginRole(database.pool, { name: 'app_api', password: 'senha-de-teste' });
  const url = new URL(database.uri);
  url.username = 'app_api';
  url.password = 'senha-de-teste';
  const appPool = createPool(url.toString());
  return {
    database,
    admin: database.pool,
    appPool,
    reseed: () => seedDatabase(database.pool),
    stop: async () => {
      await appPool.end();
      await database.stop();
    },
  };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

export interface Session {
  accessToken: string;
  headers: (storeId?: string) => Record<string, string>;
}

/** Faz o login por código e devolve o token e um montador de headers (com x-store-id). */
export async function login(server: TestApp, email: string): Promise<Session> {
  const requested = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/request',
    payload: { email },
  });
  expect(requested.statusCode).toBe(202);
  await server.auth.flush();
  const code = server.email.lastOtpFor(email)?.code;
  if (code === undefined) throw new Error(`nenhum código enviado para ${email}`);

  const verified = await server.app.inject({
    method: 'POST',
    url: '/v1/auth/otp/verify',
    payload: { email, code },
  });
  expect(verified.statusCode).toBe(200);
  const accessToken = verified.json<{ access_token: string }>().access_token;
  return {
    accessToken,
    headers: (storeId) => ({
      ...bearer(accessToken),
      ...(storeId === undefined ? {} : { 'x-store-id': storeId }),
    }),
  };
}
