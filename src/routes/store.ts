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
    showcase_enabled: { type: 'boolean', description: 'Vitrine pública ligada (opt-in)' },
    whatsapp_invite_url: {
      type: 'string',
      nullable: true,
      description: 'Link do grupo; fica público com a vitrine ligada',
    },
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
        showcase_enabled: result.store.showcaseEnabled,
        whatsapp_invite_url: result.store.whatsappInviteUrl,
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
        showcase_enabled: store.showcaseEnabled,
        whatsapp_invite_url: store.whatsappInviteUrl,
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
            whatsapp_invite_url: {
              type: 'string',
              nullable: true,
              pattern: '^https://chat\\.whatsapp\\.com/[A-Za-z0-9]{10,40}$',
              description: 'Link de convite do grupo (https://chat.whatsapp.com/...)',
            },
            showcase_enabled: {
              type: 'boolean',
              description:
                'Liga a vitrine pública. Exige o link do grupo e `acknowledge_public_group_link: true`',
            },
            acknowledge_public_group_link: {
              type: 'boolean',
              description: 'Confirma que o link do grupo ficará público na vitrine',
            },
            whatsapp_group_id: {
              type: 'string',
              nullable: true,
              maxLength: 80,
              description:
                'Grupo do WhatsApp da loja: precisa ser um `id` de `GET /v1/store/whatsapp/groups` (`422 WHATSAPP_GROUP_UNKNOWN`). `null` desfaz a escolha',
            },
          },
        },
        response: {
          200: storeResponse,
          401: problemSchema,
          403: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const auth = request.auth;
      const tenant = request.tenant;
      if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
      const body = request.body as {
        name?: string;
        inactivity_days_limit?: number | null;
        pix_key?: string | null;
        whatsapp_invite_url?: string | null;
        showcase_enabled?: boolean;
        acknowledge_public_group_link?: boolean;
        whatsapp_group_id?: string | null;
      };
      const updated = await storesService.update(
        { storeId: tenant.storeId, userId: auth.userId },
        {
          ...(body.name === undefined ? {} : { name: body.name.trim() }),
          ...(body.inactivity_days_limit === undefined
            ? {}
            : { inactivityDaysLimit: body.inactivity_days_limit }),
          ...(body.pix_key === undefined ? {} : { pixKey: body.pix_key }),
          ...(body.whatsapp_invite_url === undefined
            ? {}
            : { whatsappInviteUrl: body.whatsapp_invite_url }),
          ...(body.showcase_enabled === undefined
            ? {}
            : { showcaseEnabled: body.showcase_enabled }),
          ...(body.acknowledge_public_group_link === undefined
            ? {}
            : { acknowledgePublicGroupLink: body.acknowledge_public_group_link }),
          ...(body.whatsapp_group_id === undefined
            ? {}
            : { whatsappGroupId: body.whatsapp_group_id }),
        },
      );
      if (!updated.ok) {
        if (updated.reason === 'NOT_FOUND') throw new Error('loja do contexto não encontrada');
        if (updated.reason === 'GROUP_UNKNOWN') {
          return sendProblem(
            reply,
            buildProblem(
              422,
              'Escolha um grupo da lista publicada pelo WhatsApp da loja',
              'WHATSAPP_GROUP_UNKNOWN',
            ),
          );
        }
        return updated.reason === 'INVITE_URL_REQUIRED'
          ? sendProblem(
              reply,
              buildProblem(
                422,
                'Informe o link do grupo de WhatsApp para ligar a vitrine',
                'INVITE_URL_REQUIRED',
              ),
            )
          : sendProblem(
              reply,
              buildProblem(
                422,
                'Confirme que o link do grupo ficará público na vitrine',
                'SHOWCASE_ACK_REQUIRED',
              ),
            );
      }
      const store = updated.store;
      return {
        id: store.id,
        name: store.name,
        whatsapp_status: store.whatsappStatus,
        inactivity_days_limit: store.inactivityDaysLimit,
        pix_key: store.pixKey,
        showcase_enabled: store.showcaseEnabled,
        whatsapp_invite_url: store.whatsappInviteUrl,
      };
    },
  );
}
