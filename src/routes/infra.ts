import type { FastifyInstance } from 'fastify';
import type { Registry } from 'prom-client';

import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';

export interface InfraDeps {
  /** Resolve se o banco responde; rejeita se não. */
  checkDatabase: () => Promise<void>;
  registry: Registry;
}

/**
 * Contrato de infraestrutura: fora de /v1 e sem autenticação.
 * /health = liveness, /ready = readiness (checa o banco), /metrics = Prometheus.
 */
export function infraRoutes(app: FastifyInstance, deps: InfraDeps): void {
  app.get(
    '/health',
    {
      schema: {
        operationId: 'getHealth',
        tags: ['infra'],
        summary: 'Liveness: o processo está de pé',
        response: {
          200: {
            type: 'object',
            required: ['status'],
            properties: { status: { type: 'string', enum: ['ok'] } },
          },
        },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/ready',
    {
      schema: {
        operationId: 'getReady',
        tags: ['infra'],
        summary: 'Readiness: as dependências (banco) respondem',
        response: {
          200: {
            type: 'object',
            required: ['status'],
            properties: { status: { type: 'string', enum: ['ready'] } },
          },
          503: problemSchema,
        },
      },
    },
    async (request, reply) => {
      try {
        await deps.checkDatabase();
        return { status: 'ready' as const };
      } catch (err) {
        request.log.warn({ err }, 'readiness falhou: banco indisponível');
        return sendProblem(
          reply,
          buildProblem(503, 'Banco de dados indisponível', 'DATABASE_UNAVAILABLE'),
        );
      }
    },
  );

  app.get('/metrics', { schema: { hide: true } }, async (_request, reply) => {
    const body = await deps.registry.metrics();
    return reply.type(deps.registry.contentType).send(body);
  });
}
