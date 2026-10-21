import type { FastifyInstance } from 'fastify';

import { listActivity } from '../audit/activity.js';
import type { AuthHooks } from '../auth/hooks.js';
import type { Db } from '../db/context.js';
import { DEFAULT_LIMIT, pageQuerySchema } from '../http/pagination.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import { storeHeader } from './store.js';

export interface ActivityRouteDeps {
  db: Db;
  hooks: AuthHooks;
}

export function activityRoutes(app: FastifyInstance, deps: ActivityRouteDeps): void {
  const { db, hooks } = deps;

  app.get(
    '/v1/activity-log',
    {
      // Só o proprietário. O banco confere o papel de novo (política activity_log_select).
      preValidation: [hooks.authenticate, hooks.requireStore, hooks.requireOwner],
      schema: {
        operationId: 'listActivityLog',
        tags: ['store'],
        summary: 'Log de atividades da loja (só o proprietário)',
        security: [{ bearerAuth: [] }],
        headers: storeHeader,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            actor_user_id: {
              type: 'string',
              format: 'uuid',
              description: 'Só as ações desta pessoa (o `actor_user_id` de um item)',
            },
            action: {
              type: 'string',
              pattern: '^[a-z0-9_.]{1,64}$',
              description:
                'Ação exata (`card.created`) ou prefixo terminado em ponto (`card.` traz todas as de carta)',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['items', 'next_cursor'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'created_at', 'actor_user_id', 'actor', 'action', 'details'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    created_at: { type: 'string', format: 'date-time' },
                    actor_user_id: { type: 'string', format: 'uuid', nullable: true },
                    action: { type: 'string' },
                    actor: {
                      type: 'object',
                      nullable: true,
                      required: ['id', 'name', 'email'],
                      description:
                        'Quem agiu, enquanto for da equipe da loja. Nulo para ação do sistema e para quem saiu da equipe (use `actor_user_id` para mostrar "ex-integrante").',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string', nullable: true },
                        email: { type: 'string' },
                      },
                    },
                    target_type: { type: 'string', nullable: true },
                    target_id: { type: 'string', format: 'uuid', nullable: true },
                    details: { type: 'object', additionalProperties: true },
                  },
                },
              },
              next_cursor: { type: 'string', nullable: true },
            },
          },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      const tenant = request.tenant;
      if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
      const query = request.query as {
        cursor?: string;
        limit?: number;
        actor_user_id?: string;
        action?: string;
      };
      const result = await listActivity(
        db,
        { storeId: tenant.storeId, userId: auth.userId },
        {
          limit: query.limit ?? DEFAULT_LIMIT,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.actor_user_id === undefined ? {} : { actorUserId: query.actor_user_id }),
          ...(query.action === undefined ? {} : { action: query.action }),
        },
      );
      if (result === 'INVALID_CURSOR') {
        return sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));
      }
      return {
        items: result.items.map((entry) => ({
          id: entry.id,
          created_at: entry.createdAt.toISOString(),
          actor_user_id: entry.actorUserId,
          actor: entry.actor,
          action: entry.action,
          target_type: entry.targetType,
          target_id: entry.targetId,
          details: entry.details,
        })),
        next_cursor: result.nextCursor,
      };
    },
  );
}
