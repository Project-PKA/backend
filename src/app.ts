import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { collectDefaultMetrics, Registry } from 'prom-client';

import type { EmailSender } from './auth/email.js';
import { createAuthHooks } from './auth/hooks.js';
import { CatalogService } from './catalog/service.js';
import { createTcgdexClient, type TcgdexClient } from './catalog/tcgdex.js';
import { InvitationService } from './auth/invitations.js';
import { AuthService } from './auth/service.js';
import type { Env } from './config/env.js';
import type { Db } from './db/context.js';
import { errorHandler, notFoundHandler } from './http/problem.js';
import { authRoutes } from './routes/auth.js';
import { infraRoutes } from './routes/infra.js';
import { activityRoutes } from './routes/activity.js';
import { catalogRoutes } from './routes/catalog.js';
import { meRoutes } from './routes/me.js';
import { storeRoutes } from './routes/store.js';
import { teamRoutes } from './routes/team.js';
import { StoreService } from './stores/service.js';
import { TeamService } from './team/service.js';

export interface AppDeps {
  env: Env;
  db: Db;
  email: EmailSender;
  /** Resolve se o banco responde; rejeita se não. */
  checkDatabase: () => Promise<void>;
  /** Relógio injetável, para testar expiração. */
  now?: () => Date;
  /** Cliente do catálogo. Os testes injetam um falso; em produção é o do TCGdex. */
  tcgdex?: TcgdexClient;
}

export interface BuiltApp {
  app: FastifyInstance;
  auth: AuthService;
  invitations: InvitationService;
  stores: StoreService;
  team: TeamService;
  catalog: CatalogService;
}

const TRACEPARENT = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/;

/** Reaproveita o trace_id do header W3C `traceparent`; senão gera um novo. */
function traceIdFrom(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value === undefined ? null : TRACEPARENT.exec(value);
  return match?.[1] ?? randomBytes(16).toString('hex');
}

function readVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf-8');
  return (JSON.parse(raw) as { version: string }).version;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { env } = deps;
  const app = Fastify({
    logger: {
      level: env.logLevel,
      base: { service: env.serviceName },
      messageKey: 'message',
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      // Credenciais e cookies nunca vão para o log.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[REDACTED]',
      },
    },
    logController: new LogController({ requestIdLogLabel: 'trace_id' }),
    genReqId: (req) => traceIdFrom(req.headers['traceparent']),
    trustProxy: env.trustProxy,
    // Limites explícitos (SECURITY.md): corpo pequeno e nada fica pendurado.
    bodyLimit: env.http.bodyLimitBytes,
    requestTimeout: env.http.requestTimeoutMs,
    handlerTimeout: env.http.handlerTimeoutMs,
    // Descarta campo que o schema não declara (os corpos usam additionalProperties: false).
    ajv: { customOptions: { removeAdditional: true } },
  });

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  app.addHook('onClose', () => {
    registry.clear();
  });

  app.decorateRequest('auth', null);
  app.decorateRequest('tenant', null);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(helmet);
  await app.register(cors, {
    origin: env.corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Store-Id', 'Traceparent'],
    maxAge: 600,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: env.rateLimit.global,
    timeWindow: '1 minute',
    // Vira um erro comum e passa pelo errorHandler (problem+json com code RATE_LIMITED).
    errorResponseBuilder: () =>
      Object.assign(new Error('Muitas requisições. Tente novamente em instantes'), {
        statusCode: 429,
      }),
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'pokemonAuction API',
        description: 'API do SaaS de leilões de cartas TCG via WhatsApp (nome provisório).',
        version: readVersion(),
      },
      tags: [
        { name: 'infra', description: 'Health check, readiness e métricas' },
        {
          name: 'auth',
          description: 'Login por código (acesso só por convite), sessão e convites',
        },
        { name: 'me', description: 'Perfil, lojas e sessões de quem está logado' },
        {
          name: 'store',
          description: 'Criar loja e rotas de uma loja (exigem o header x-store-id)',
        },
        { name: 'team', description: 'Equipe e convites da loja (só o proprietário altera)' },
        { name: 'catalog', description: 'Catálogo de cartas (busca e detalhe)' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });

  const logger = {
    error: (object: Record<string, unknown>, message: string) => {
      app.log.error(object, message);
    },
  };
  const auth = new AuthService({
    db: deps.db,
    config: env.auth,
    email: deps.email,
    log: logger,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const invitations = new InvitationService({
    db: deps.db,
    config: env.auth,
    email: deps.email,
    publicAppUrl: env.publicAppUrl,
    log: logger,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const hooks = createAuthHooks({ db: deps.db, config: env.auth });

  infraRoutes(app, { checkDatabase: deps.checkDatabase, registry });
  authRoutes(app, { env, auth, invitations });
  meRoutes(app, { db: deps.db, auth, hooks });
  const storesService = new StoreService(deps.db);
  const team = new TeamService(deps.db);
  storeRoutes(app, { db: deps.db, hooks, storesService });
  teamRoutes(app, { hooks, team, invitations });
  activityRoutes(app, { db: deps.db, hooks });
  const catalog = new CatalogService(deps.db, deps.tcgdex ?? createTcgdexClient(), {
    warn: (object, message) => {
      app.log.warn(object, message);
    },
  });
  catalogRoutes(app, { hooks, catalog });

  return { app, auth, invitations, stores: storesService, team, catalog };
}
