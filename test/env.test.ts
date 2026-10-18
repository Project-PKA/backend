import { describe, expect, it } from 'vitest';

import { loadEnv } from '../src/config/env.js';

const secrets = {
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  REFRESH_TOKEN_PEPPER: 'b'.repeat(32),
  OTP_HASH_SECRET: 'c'.repeat(32),
};
const base = { DATABASE_URL: 'postgresql://app:app@localhost:5432/app', ...secrets };

describe('loadEnv', () => {
  it('aplica os padrões quando só o obrigatório está presente', () => {
    const env = loadEnv(base);

    expect(env).toMatchObject({
      appEnv: 'local',
      port: 8080,
      logLevel: 'info',
      serviceName: 'api',
      databaseUrl: base.DATABASE_URL,
      trustProxy: false,
      corsOrigins: [],
      emailProvider: 'log',
      secureCookies: false,
      rateLimit: { global: 120, otpRequest: 5, otpVerify: 10 },
    });
    expect(env.auth).toMatchObject({
      accessTtlSeconds: 900,
      refreshTtlDays: 30,
      otpTtlSeconds: 600,
      otpMaxAttempts: 5,
      otpResendSeconds: 60,
      invitationTtlDays: 7,
      invitationResendSeconds: 60,
    });
    expect(env.http).toEqual({
      bodyLimitBytes: 262_144,
      requestTimeoutMs: 30_000,
      handlerTimeoutMs: 20_000,
    });
  });

  it('falha no boot sem DATABASE_URL', () => {
    expect(() => loadEnv({ ...secrets })).toThrow('DATABASE_URL');
  });

  it.each(['JWT_ACCESS_SECRET', 'REFRESH_TOKEN_PEPPER', 'OTP_HASH_SECRET'])(
    'exige %s com pelo menos 32 caracteres',
    (name) => {
      expect(() => loadEnv({ ...base, [name]: undefined })).toThrow(name);
      expect(() => loadEnv({ ...base, [name]: 'curto' })).toThrow('pelo menos 32 caracteres');
    },
  );

  it('rejeita porta inválida', () => {
    expect(() => loadEnv({ ...base, PORT: 'abc' })).toThrow('PORT inválida');
    expect(() => loadEnv({ ...base, PORT: '70000' })).toThrow('PORT inválida');
  });

  it('rejeita APP_ENV e LOG_LEVEL fora da lista', () => {
    expect(() => loadEnv({ ...base, APP_ENV: 'staging' })).toThrow('APP_ENV inválida');
    expect(() => loadEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL inválida');
  });

  it('recusa o provedor de e-mail "log" em homolog e prod', () => {
    expect(() => loadEnv({ ...base, APP_ENV: 'prod' })).toThrow('EMAIL_PROVIDER=log');
    expect(() => loadEnv({ ...base, APP_ENV: 'homolog' })).toThrow('EMAIL_PROVIDER=log');
    expect(() => loadEnv({ ...base, APP_ENV: 'dev' })).not.toThrow();
  });

  it('não aceita CORS com curinga nem origem malformada', () => {
    expect(() => loadEnv({ ...base, CORS_ORIGINS: '*' })).toThrow('não aceita "*"');
    expect(() => loadEnv({ ...base, CORS_ORIGINS: 'isto-nao-e-url' })).toThrow('origem inválida');
    expect(
      loadEnv({ ...base, CORS_ORIGINS: 'https://a.test, https://b.test' }).corsOrigins,
    ).toEqual(['https://a.test', 'https://b.test']);
  });

  it('valida os limites numéricos', () => {
    expect(() => loadEnv({ ...base, OTP_MAX_ATTEMPTS: '0' })).toThrow('OTP_MAX_ATTEMPTS');
    expect(() => loadEnv({ ...base, ACCESS_TOKEN_TTL_SECONDS: '999999' })).toThrow(
      'ACCESS_TOKEN_TTL_SECONDS',
    );
  });

  it('valida os limites de HTTP', () => {
    expect(() => loadEnv({ ...base, BODY_LIMIT_BYTES: '10' })).toThrow('BODY_LIMIT_BYTES');
    expect(() => loadEnv({ ...base, REQUEST_TIMEOUT_MS: '99999999' })).toThrow(
      'REQUEST_TIMEOUT_MS',
    );
    expect(loadEnv({ ...base, BODY_LIMIT_BYTES: '4096' }).http.bodyLimitBytes).toBe(4096);
  });

  it('cookie seguro em tudo que não é local nem teste', () => {
    expect(loadEnv({ ...base, APP_ENV: 'dev' }).secureCookies).toBe(true);
    expect(loadEnv({ ...base, APP_ENV: 'test' }).secureCookies).toBe(false);
  });
});
