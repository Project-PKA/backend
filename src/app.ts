import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import swagger from '@fastify/swagger';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { collectDefaultMetrics, Registry } from 'prom-client';

import type { Env } from './config/env.js';
import { errorHandler, notFoundHandler } from './http/problem.js';
import { infraRoutes } from './routes/infra.js';

export interface AppDeps {
  env: Pick<Env, 'logLevel' | 'serviceName'>;
  /** Resolve se o banco responde; rejeita se não. */
  checkDatabase: () => Promise<void>;
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

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: deps.env.logLevel,
      base: { service: deps.env.serviceName },
      messageKey: 'message',
      timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
    },
    logController: new LogController({ requestIdLogLabel: 'trace_id' }),
    genReqId: (req) => traceIdFrom(req.headers['traceparent']),
    // Aceita só o que o schema da rota declara.
    ajv: { customOptions: { removeAdditional: 'all' } },
  });

  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  app.addHook('onClose', () => {
    registry.clear();
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'pokemonAuction API',
        description: 'API do SaaS de leilões de cartas TCG via WhatsApp (nome provisório).',
        version: readVersion(),
      },
      tags: [{ name: 'infra', description: 'Health check, readiness e métricas' }],
    },
  });

  infraRoutes(app, { checkDatabase: deps.checkDatabase, registry });

  return app;
}
