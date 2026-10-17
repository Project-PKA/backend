const APP_ENVS = ['local', 'dev', 'test', 'homolog', 'prod'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
const EMAIL_PROVIDERS = ['log'] as const;

export type AppEnv = (typeof APP_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export interface AuthConfig {
  /** Assina o JWT de acesso (HS256). Mínimo de 32 caracteres. */
  accessSecret: string;
  accessTtlSeconds: number;
  issuer: string;
  audience: string;
  /** Tempero do hash do refresh token. */
  refreshPepper: string;
  refreshTtlDays: number;
  /** Chave do HMAC do OTP. */
  otpSecret: string;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  otpResendSeconds: number;
  invitationTtlDays: number;
  /** Intervalo mínimo entre reenvios do mesmo convite. */
  invitationResendSeconds: number;
}

export interface RateLimitConfig {
  /** Requisições por minuto e por IP, em qualquer rota. */
  global: number;
  otpRequest: number;
  otpVerify: number;
}

export interface HttpLimits {
  /** Tamanho máximo do corpo de uma requisição. */
  bodyLimitBytes: number;
  /** Tempo máximo para receber a requisição inteira. */
  requestTimeoutMs: number;
  /** Tempo máximo para o handler responder. */
  handlerTimeoutMs: number;
}

export interface Env {
  appEnv: AppEnv;
  port: number;
  logLevel: LogLevel;
  serviceName: string;
  databaseUrl: string;
  /** Atrás de reverse proxy, o IP real vem de X-Forwarded-For. */
  trustProxy: boolean;
  /** Origens autorizadas a chamar a API pelo navegador. Vazio = nenhuma. */
  corsOrigins: string[];
  /** URL pública do frontend, usada nos links de convite. */
  publicAppUrl: string;
  emailProvider: EmailProvider;
  /** Cookie `Secure` em tudo que não é desenvolvimento local. */
  secureCookies: boolean;
  rateLimit: RateLimitConfig;
  http: HttpLimits;
  auth: AuthConfig;
}

type Source = NodeJS.ProcessEnv;

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const found = allowed.find((item) => item === value);
  if (found === undefined) {
    throw new Error(`${name} inválida: "${value}". Valores aceitos: ${allowed.join(', ')}`);
  }
  return found;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT inválida: "${value}". Use um inteiro entre 1 e 65535`);
  }
  return port;
}

function required(source: Source, name: string): string {
  const value = source[name];
  if (value === undefined || value === '') {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

function secret(source: Source, name: string): string {
  const value = required(source, name);
  if (value.length < 32) {
    throw new Error(`${name} precisa ter pelo menos 32 caracteres`);
  }
  return value;
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} inválida: use um inteiro entre ${min} e ${max}`);
  }
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function parseOrigins(value: string | undefined): string[] {
  const origins = list(value);
  for (const origin of origins) {
    if (origin === '*') throw new Error('CORS_ORIGINS não aceita "*": liste as origens');
    try {
      new URL(origin);
    } catch {
      throw new Error(`CORS_ORIGINS tem uma origem inválida: "${origin}"`);
    }
  }
  return origins;
}

function parseAuth(source: Source): AuthConfig {
  return {
    accessSecret: secret(source, 'JWT_ACCESS_SECRET'),
    accessTtlSeconds: integer(source, 'ACCESS_TOKEN_TTL_SECONDS', 900, 60, 3600),
    issuer: source['JWT_ISSUER'] ?? 'pokemon-auction',
    audience: source['JWT_AUDIENCE'] ?? 'pokemon-auction-api',
    refreshPepper: secret(source, 'REFRESH_TOKEN_PEPPER'),
    refreshTtlDays: integer(source, 'REFRESH_TOKEN_TTL_DAYS', 30, 1, 90),
    otpSecret: secret(source, 'OTP_HASH_SECRET'),
    otpTtlSeconds: integer(source, 'OTP_TTL_SECONDS', 600, 60, 3600),
    otpMaxAttempts: integer(source, 'OTP_MAX_ATTEMPTS', 5, 1, 10),
    otpResendSeconds: integer(source, 'OTP_RESEND_SECONDS', 60, 0, 600),
    invitationTtlDays: integer(source, 'INVITATION_TTL_DAYS', 7, 1, 30),
    invitationResendSeconds: integer(source, 'INVITATION_RESEND_SECONDS', 60, 0, 3600),
  };
}

/** Lê e valida o ambiente. Falha no boot se algo faltar ou for inválido. */
export function loadEnv(source: Source = process.env): Env {
  const appEnv = oneOf('APP_ENV', source['APP_ENV'] ?? 'local', APP_ENVS);
  const emailProvider = oneOf('EMAIL_PROVIDER', source['EMAIL_PROVIDER'] ?? 'log', EMAIL_PROVIDERS);
  const isLive = appEnv === 'homolog' || appEnv === 'prod';
  if (isLive && emailProvider === 'log') {
    // O provedor "log" imprime o código no log: serve só para desenvolvimento.
    throw new Error(
      `EMAIL_PROVIDER=log é recusado em APP_ENV=${appEnv}: configure um provedor real`,
    );
  }
  return {
    appEnv,
    port: parsePort(source['PORT'] ?? '8080'),
    logLevel: oneOf('LOG_LEVEL', source['LOG_LEVEL'] ?? 'info', LOG_LEVELS),
    serviceName: source['OTEL_SERVICE_NAME'] ?? 'api',
    databaseUrl: required(source, 'DATABASE_URL'),
    trustProxy: source['TRUST_PROXY'] === 'true',
    corsOrigins: parseOrigins(source['CORS_ORIGINS']),
    publicAppUrl: source['APP_PUBLIC_URL'] ?? 'http://localhost:3000',
    emailProvider,
    secureCookies: appEnv !== 'local' && appEnv !== 'test',
    rateLimit: {
      global: integer(source, 'RATE_LIMIT_PER_MINUTE', 120, 1, 100_000),
      otpRequest: integer(source, 'RATE_LIMIT_OTP_REQUEST_PER_MINUTE', 5, 1, 1000),
      otpVerify: integer(source, 'RATE_LIMIT_OTP_VERIFY_PER_MINUTE', 10, 1, 1000),
    },
    http: {
      bodyLimitBytes: integer(source, 'BODY_LIMIT_BYTES', 262_144, 1024, 10_485_760),
      requestTimeoutMs: integer(source, 'REQUEST_TIMEOUT_MS', 30_000, 1000, 300_000),
      handlerTimeoutMs: integer(source, 'HANDLER_TIMEOUT_MS', 20_000, 1000, 300_000),
    },
    auth: parseAuth(source),
  };
}
