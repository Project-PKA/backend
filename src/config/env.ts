const APP_ENVS = ['local', 'dev', 'test', 'homolog', 'prod'] as const;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type AppEnv = (typeof APP_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Env {
  appEnv: AppEnv;
  port: number;
  logLevel: LogLevel;
  serviceName: string;
  databaseUrl: string;
}

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

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (value === undefined || value === '') {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

/** Lê e valida o ambiente. Falha no boot se algo faltar ou for inválido. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return {
    appEnv: oneOf('APP_ENV', source['APP_ENV'] ?? 'local', APP_ENVS),
    port: parsePort(source['PORT'] ?? '8080'),
    logLevel: oneOf('LOG_LEVEL', source['LOG_LEVEL'] ?? 'info', LOG_LEVELS),
    serviceName: source['OTEL_SERVICE_NAME'] ?? 'api',
    databaseUrl: required(source, 'DATABASE_URL'),
  };
}
