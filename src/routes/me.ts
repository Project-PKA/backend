import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import type { AuthService } from '../auth/service.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import { REFRESH_COOKIE } from './auth.js';

const { users, stores, storeMembers } = schema;

export interface MeRouteDeps {
  db: Db;
  auth: AuthService;
  hooks: AuthHooks;
}

const security = [{ bearerAuth: [] }];

export function meRoutes(app: FastifyInstance, deps: MeRouteDeps): void {
  const { db, auth, hooks } = deps;
  // `preValidation`: quem não está autenticado recebe 401 antes de qualquer erro de formato.
  const onlyAuthenticated = { preValidation: [hooks.authenticate] };

  app.get(
    '/v1/me',
    {
      ...onlyAuthenticated,
      schema: {
        operationId: 'getMe',
        tags: ['me'],
        summary: 'Perfil de quem está logado',
        security,
        response: {
          200: {
            type: 'object',
            required: [
              'id',
              'email',
              'name',
              'is_platform_admin',
              'can_create_stores',
              'store_limit',
            ],
            properties: {
              id: { type: 'string', format: 'uuid' },
              email: { type: 'string' },
              name: { type: 'string', nullable: true },
              is_platform_admin: { type: 'boolean' },
              can_create_stores: { type: 'boolean' },
              store_limit: { type: 'integer' },
            },
          },
          401: problemSchema,
        },
      },
    },
    async (request) => {
      const current = request.auth;
      if (current === null) throw new Error('authenticate não definiu request.auth');
      const [user] = await db.select().from(users).where(eq(users.id, current.userId)).limit(1);
      return {
        id: current.userId,
        email: current.email,
        name: user?.name ?? null,
        is_platform_admin: current.isPlatformAdmin,
        can_create_stores: current.canCreateStores,
        store_limit: current.storeLimit,
      };
    },
  );

  app.get(
    '/v1/me/stores',
    {
      ...onlyAuthenticated,
      schema: {
        operationId: 'listMyStores',
        tags: ['me'],
        summary: 'Lojas de que a pessoa participa (para escolher uma)',
        security,
        response: {
          200: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'name', 'role', 'whatsapp_status'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    role: { type: 'string', enum: ['OWNER', 'STAFF'] },
                    whatsapp_status: { type: 'string', enum: ['ONLINE', 'OFFLINE', 'QR_READY'] },
                  },
                },
              },
            },
          },
          401: problemSchema,
        },
      },
    },
    async (request) => {
      const current = request.auth;
      if (current === null) throw new Error('authenticate não definiu request.auth');
      const items = await withContext(db, { userId: current.userId }, (tx) =>
        tx
          .select({
            id: stores.id,
            name: stores.name,
            role: storeMembers.role,
            whatsapp_status: stores.whatsappStatus,
          })
          .from(storeMembers)
          .innerJoin(stores, eq(stores.id, storeMembers.storeId))
          .where(eq(storeMembers.userId, current.userId))
          .orderBy(stores.name),
      );
      return { items };
    },
  );

  app.get(
    '/v1/me/sessions',
    {
      ...onlyAuthenticated,
      schema: {
        operationId: 'listMySessions',
        tags: ['me'],
        summary: 'Sessões ativas da pessoa',
        security,
        response: {
          200: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'created_at', 'user_agent', 'ip', 'current'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    created_at: { type: 'string', format: 'date-time' },
                    user_agent: { type: 'string', nullable: true },
                    ip: { type: 'string', nullable: true },
                    current: { type: 'boolean' },
                  },
                },
              },
            },
          },
          401: problemSchema,
        },
      },
    },
    async (request) => {
      const current = request.auth;
      if (current === null) throw new Error('authenticate não definiu request.auth');
      const raw = request.cookies[REFRESH_COOKIE] ?? null;
      const sessions = await auth.listSessions(current.userId, raw);
      return {
        items: sessions.map((session) => ({
          id: session.id,
          created_at: session.createdAt.toISOString(),
          user_agent: session.userAgent,
          ip: session.ip,
          current: session.current,
        })),
      };
    },
  );

  app.delete(
    '/v1/me/sessions/:id',
    {
      ...onlyAuthenticated,
      schema: {
        operationId: 'revokeMySession',
        tags: ['me'],
        summary: 'Encerra uma das próprias sessões',
        security,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        response: { 204: { type: 'null' }, 401: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const current = request.auth;
      if (current === null) throw new Error('authenticate não definiu request.auth');
      const { id } = request.params as { id: string };
      const revoked = await auth.revokeSession(current.userId, id);
      if (!revoked) {
        return sendProblem(reply, buildProblem(404, 'Sessão não encontrada', 'SESSION_NOT_FOUND'));
      }
      return reply.status(204).send();
    },
  );
}
