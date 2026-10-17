import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';

const base = { DATABASE_URL: 'postgresql://app:app@localhost:5432/app' };

describe('loadEnv', () => {
  it('aplica os padrões quando só o obrigatório está presente', () => {
    expect(loadEnv(base)).toEqual({
      appEnv: 'local',
      port: 8080,
      logLevel: 'info',
      serviceName: 'api',
      databaseUrl: base.DATABASE_URL,
    });
  });

  it('falha no boot sem DATABASE_URL', () => {
    expect(() => loadEnv({})).toThrow('DATABASE_URL');
  });

  it('rejeita porta inválida', () => {
    expect(() => loadEnv({ ...base, PORT: 'abc' })).toThrow('PORT inválida');
    expect(() => loadEnv({ ...base, PORT: '70000' })).toThrow('PORT inválida');
  });

  it('rejeita APP_ENV e LOG_LEVEL fora da lista', () => {
    expect(() => loadEnv({ ...base, APP_ENV: 'staging' })).toThrow('APP_ENV inválida');
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL inválida');
  });
});
