import type pg from 'pg';

import { buildApp, type BuiltApp } from '../../src/app.js';
import { MemoryEmailSender } from '../../src/auth/email.js';
import type { TcgdexClient } from '../../src/catalog/tcgdex.js';
import { createPool } from '../../src/db/client.js';
import { createDb, type Db } from '../../src/db/context.js';
import { loadEnv, type Env } from '../../src/config/env.js';

/** Valores só de teste: longos o bastante para passar na validação, sem valor real. */
export function testEnv(overrides: NodeJS.ProcessEnv = {}): Env {
  return loadEnv({
    APP_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://teste:teste@127.0.0.1:1/teste',
    JWT_ACCESS_SECRET: 'teste-jwt-access-secret-0123456789abcdef',
    REFRESH_TOKEN_PEPPER: 'teste-refresh-pepper-0123456789abcdef',
    OTP_HASH_SECRET: 'teste-otp-hash-secret-0123456789abcdef',
    CORS_ORIGINS: 'http://localhost:3000',
    OTP_RESEND_SECONDS: '0',
    RATE_LIMIT_PER_MINUTE: '100000',
    RATE_LIMIT_OTP_REQUEST_PER_MINUTE: '1000',
    RATE_LIMIT_OTP_VERIFY_PER_MINUTE: '1000',
    RATE_LIMIT_PUBLIC_PER_MINUTE: '1000',
    ...overrides,
  });
}

export interface TestApp extends BuiltApp {
  email: MemoryEmailSender;
  db: Db;
  env: Env;
  close: () => Promise<void>;
}

interface Options {
  env?: NodeJS.ProcessEnv;
  /** Pool de um banco real. Sem ele, o pool nunca conecta (testes sem banco). */
  pool?: pg.Pool;
  checkDatabase?: () => Promise<void>;
  now?: () => Date;
  tcgdex?: TcgdexClient;
  /** `false` deixa registrar hooks depois de criar o app. */
  ready?: boolean;
}

export async function buildTestApp(options: Options = {}): Promise<TestApp> {
  const env = testEnv(options.env);
  const pool = options.pool ?? createPool(env.databaseUrl);
  const db = createDb(pool);
  const email = new MemoryEmailSender();
  const built = await buildApp({
    env,
    db,
    email,
    checkDatabase: options.checkDatabase ?? (() => Promise.resolve()),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.tcgdex === undefined ? {} : { tcgdex: options.tcgdex }),
  });
  if (options.ready !== false) await built.app.ready();
  return {
    ...built,
    email,
    db,
    env,
    close: async () => {
      await built.auth.flush();
      await built.invitations.flush();
      await built.app.close();
      if (options.pool === undefined) await pool.end();
    },
  };
}
