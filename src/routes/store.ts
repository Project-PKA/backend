import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import type { StoreService } from '../stores/service.js';

const { stores } = schema;

export interface StoreRouteDeps {
  db: Db;
  hooks: AuthHooks;
  storesService: StoreService;
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

const nameSchema = { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' } as const;

const storeResponse = {
  type: 'object',
  required: ['id', 'name', 'whatsapp_status', 'inactivity_days_limit'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    whatsapp_status: { type: 'string', enum: ['ONLINE', 'OFFLINE', 'QR_READY'] },
    inactivity_days_limit: { type: 'integer', nullable: true },
    pix_key: { type: 'string', nullable: true, description: 'Chave PIX mostrada ao comprador' },
  },
} as const;

export function storeRoutes(app: FastifyInstance, deps: StoreRouteDeps): void {
  const { db, hooks, storesService } = deps;

  app.post(
    '/v1/stores',
    {
      preValidation: [hooks.authenticate],
      schema: {
        operationId: 'createStore',
        tags: ['store'],
        summary: 'Cria uma loja (só com a permissão global e dentro do limite)',
        description:
          'Exige `can_create_stores` e respeita `store_limit`, contado em lojas em que a pessoa é proprietária. ' +
          'Quem não tem a permissão pede ao administrador da plataforma.',
        security,
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: { name: nameSchema },
        },
        response: {
          201: {
            type: 'object',
            required: ['id', 'name', 'whatsapp_status', 'inactivity_days_limit', 'role'],
            properties: {
              ...storeResponse.properties,
              role: { type: 'string', enum: ['OWNER'] },
            },
          },
          401: problemSchema,
          403: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      if (auth === null) throw new Error('authenticate não definiu request.auth');
      const { name } = request.body as { name: string };
      const result = await storesService.create(auth.userId, name.trim());
      if (!result.ok) {
        return result.reason === 'NOT_ALLOWED'
          ? sendProblem(
              reply,
              buildProblem(403, 'Sem permissão para criar lojas', 'CANNOT_CREATE_STORES'),
            )
          : sendProblem(
              reply,
              buildProblem(409, 'Limite de lojas atingido', 'STORE_LIMIT_REACHED'),
            );
      }
      return reply.status(201).send({
        id: result.store.id,
        name: result.store.name,
        whatsapp_status: result.store.whatsappStatus,
        inactivity_days_limit: result.store.inactivityDaysLimit,
        pix_key: result.store.pixKey,
        role: 'OWNER',
      });
    },
  );

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
              ...storeResponse.properties,
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
        pix_key: store.pixKey,
        role: tenant.role,
        permissions: tenant.permissions,
      };
    },
  );

  app.patch(
    '/v1/store',
    {
      preValidation: [hooks.authenticate, hooks.requireStore, hooks.requireOwner],
      schema: {
        operationId: 'updateCurrentStore',
        tags: ['store'],
        summary: 'Edita o nome e o limite de inatividade da loja (só o proprietário)',
        security,
        headers: storeHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: nameSchema,
            inactivity_days_limit: {
              type: 'integer',
              nullable: true,
              minimum: 1,
              maximum: 3650,
              description: 'Dias sem interação até o bot remover o membro do grupo. `null` desliga',
            },
            pix_key: { type: 'string', nullable: true, minLength: 1, maxLength: 140 },
          },
        },
        response: {
          200: storeResponse,
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async (request) => {
      const auth = request.auth;
      const tenant = request.tenant;
      if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
      const body = request.body as {
        name?: string;
        inactivity_days_limit?: number | null;
        pix_key?: string | null;
      };
      const updated = await storesService.update(
        { storeId: tenant.storeId, userId: auth.userId },
        {
          ...(body.name === undefined ? {} : { name: body.name.trim() }),
          ...(body.inactivity_days_limit === undefined
            ? {}
            : { inactivityDaysLimit: body.inactivity_days_limit }),
          ...(body.pix_key === undefined ? {} : { pixKey: body.pix_key }),
        },
      );
      if (updated === null) throw new Error('loja do contexto não encontrada');
      return {
        id: updated.id,
        name: updated.name,
        whatsapp_status: updated.whatsappStatus,
        inactivity_days_limit: updated.inactivityDaysLimit,
        pix_key: updated.pixKey,
      };
    },
  );
}
