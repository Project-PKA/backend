import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { problemSchema } from '../http/problem.js';

const { stores } = schema;

export interface StoreRouteDeps {
  db: Db;
  hooks: AuthHooks;
}

const security = [{ bearerAuth: [] }];

/** Documentação do header; a validação real é do hook `requireStore`. */
export const storeHeader = {
  type: 'object',
  properties: {
    'x-store-id': {
      type: 'string',
      description:
        'Id da loja. Obrigatório nas rotas de uma loja; só vale se a pessoa participa dela',
    },
  },
} as const;

export function storeRoutes(app: FastifyInstance, deps: StoreRouteDeps): void {
  const { db, hooks } = deps;

  app.get(
    '/v1/store',
    {
      preValidation: [hooks.authenticate, hooks.requireStore],
      schema: {
        operationId: 'getCurrentStore',
        tags: ['store'],
        summary: 'Loja do contexto (x-store-id) com o papel e as permissões de quem pergunta',
        security,
        headers: storeHeader,
        response: {
          200: {
            type: 'object',
            required: ['id', 'name', 'whatsapp_status', 'role', 'permissions'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              name: { type: 'string' },
              whatsapp_status: { type: 'string', enum: ['ONLINE', 'OFFLINE', 'QR_READY'] },
              inactivity_days_limit: { type: 'integer', nullable: true },
              role: { type: 'string', enum: ['OWNER', 'STAFF'] },
              permissions: { type: 'object', additionalProperties: { type: 'boolean' } },
            },
          },
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async (request) => {
      const tenant = request.tenant;
      if (tenant === null) throw new Error('requireStore não definiu request.tenant');
      const store = await withContext(db, { storeId: tenant.storeId }, async (tx) => {
        const [row] = await tx.select().from(stores).where(eq(stores.id, tenant.storeId)).limit(1);
        return row;
      });
      if (store === undefined) throw new Error('loja do contexto não encontrada');
      return {
        id: store.id,
        name: store.name,
        whatsapp_status: store.whatsappStatus,
        inactivity_days_limit: store.inactivityDaysLimit,
        role: tenant.role,
        permissions: tenant.permissions,
      };
    },
  );
}
