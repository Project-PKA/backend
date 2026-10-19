import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';
import { parseRedisUrl } from '../src/jobs/redis.js';

describe('parseRedisUrl', () => {
  it('lê host, porta, senha e banco', () => {
    expect(parseRedisUrl('redis://:s%40nha@cache.interno:6380/2')).toEqual({
      host: 'cache.interno',
      port: 6380,
      password: 's@nha',
      db: 2,
    });
  });

  it('usa os padrões e liga TLS no rediss', () => {
    expect(parseRedisUrl('rediss://localhost')).toEqual({
      host: 'localhost',
      port: 6379,
      db: 0,
      tls: {},
    });
  });

  it.each(['', 'nao-e-url', 'http://localhost', 'redis://localhost/99', 'redis://localhost/x'])(
    'recusa %j sem vazar a senha',
    (value) => {
      expect(() => parseRedisUrl(value)).toThrow('REDIS_URL inválida');
    },
  );
});

describe('variáveis dos jobs', () => {
  const base = {
    DATABASE_URL: 'postgresql://app:app@localhost:5432/app',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    REFRESH_TOKEN_PEPPER: 'b'.repeat(32),
    OTP_HASH_SECRET: 'c'.repeat(32),
    CPF_ENCRYPTION_KEY: 'd'.repeat(32),
  };

  it('Redis é opcional em desenvolvimento e o catálogo vem em en e pt', () => {
    const env = loadEnv(base);
    expect(env.redisUrl).toBeNull();
    expect(env.catalogLanguages).toEqual(['en', 'pt']);
  });

  it('valida os idiomas e tira repetidos', () => {
    expect(loadEnv({ ...base, CATALOG_LANGUAGES: 'pt, en,pt' }).catalogLanguages).toEqual([
      'pt',
      'en',
    ]);
    expect(() => loadEnv({ ...base, CATALOG_LANGUAGES: 'en,../x' })).toThrow('idioma inválido');
    expect(() => loadEnv({ ...base, CATALOG_LANGUAGES: 'a,b,c,d,e,fg' })).toThrow();
  });
});
