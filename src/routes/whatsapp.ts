import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import type { PairingStatus, WhatsappPairingService } from '../whatsapp/pairing.js';
import { storeHeader } from './store.js';

export interface WhatsappRouteDeps {
  hooks: AuthHooks;
  pairing: WhatsappPairingService;
}

const security = [{ bearerAuth: [] }];
const STATES = ['IDLE', 'REQUESTED', 'QR_READY', 'ONLINE', 'OFFLINE'] as const;

const statusResponse = {
  type: 'object',
  required: ['state', 'requested_at', 'qr', 'group_id', 'groups_updated_at'],
  properties: {
    state: {
      type: 'string',
      enum: STATES,
      description:
        '`IDLE`: nunca conectou. `REQUESTED`: pedido feito, o bot ainda não gerou o QR. `QR_READY`: há um QR válido. `ONLINE`: conectado. `OFFLINE`: já houve sessão pareada e a conexão caiu.',
    },
    requested_at: { type: 'string', format: 'date-time', nullable: true },
    qr: {
      type: 'object',
      nullable: true,
      required: ['code', 'expires_at'],
      description:
        'O QR atual, só enquanto vale (60 s). Quem o escaneia liga a conta de WhatsApp dele ao bot: mostre só ao proprietário, não guarde nem registre.',
      properties: {
        code: { type: 'string' },
        expires_at: { type: 'string', format: 'date-time' },
      },
    },
    group_id: { type: 'string', nullable: true, description: 'Grupo escolhido da loja' },
    groups_updated_at: { type: 'string', format: 'date-time', nullable: true },
  },
} as const;

const toStatusJson = (status: PairingStatus) => ({
  state: status.state,
  requested_at: status.requestedAt?.toISOString() ?? null,
  qr:
    status.qr === null
      ? null
      : { code: status.qr.code, expires_at: status.qr.expiresAt.toISOString() },
  group_id: status.groupId,
  groups_updated_at: status.groupsUpdatedAt?.toISOString() ?? null,
});

/** Pareamento do WhatsApp pelo painel (shared#36, D20). Tudo é só do proprietário da loja. */
export function whatsappRoutes(app: FastifyInstance, deps: WhatsappRouteDeps): void {
  const { hooks, pairing } = deps;
  const owner = [hooks.authenticate, hooks.requireStore, hooks.requireOwner];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };

  app.post(
    '/v1/store/whatsapp/pair',
    {
      preValidation: owner,
      schema: {
        operationId: 'requestWhatsappPairing',
        tags: ['whatsapp'],
        summary: 'Pede o QR para parear o WhatsApp da loja (só o proprietário)',
        description:
          'Grava o pedido; o bot o atende e publica o QR, que se lê em `GET /v1/store/whatsapp`. Repetir em menos de 30 s devolve o estado sem renovar.',
        security,
        headers: storeHeader,
        response: {
          202: statusResponse,
          401: problemSchema,
          403: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await pairing.requestPair(contextOf(request));
      if (!result.ok) {
        return sendProblem(
          reply,
          buildProblem(409, 'O WhatsApp da loja já está conectado', 'WHATSAPP_ALREADY_CONNECTED'),
        );
      }
      return reply
        .status(202)
        .header('Cache-Control', 'no-store')
        .send(toStatusJson(result.status));
    },
  );

  app.get(
    '/v1/store/whatsapp',
    {
      preValidation: owner,
      schema: {
        operationId: 'getWhatsappPairing',
        tags: ['whatsapp'],
        summary: 'Estado do WhatsApp da loja e o QR atual (só o proprietário)',
        description:
          'Consulte a cada poucos segundos enquanto o estado for `REQUESTED` ou `QR_READY`. A resposta nunca é guardada em cache.',
        security,
        headers: storeHeader,
        response: { 200: statusResponse, 401: problemSchema, 403: problemSchema },
      },
    },
    async (request, reply) => {
      const status = await pairing.status(contextOf(request));
      return reply.header('Cache-Control', 'no-store').send(toStatusJson(status));
    },
  );

  app.get(
    '/v1/store/whatsapp/groups',
    {
      preValidation: owner,
      schema: {
        operationId: 'listWhatsappGroups',
        tags: ['whatsapp'],
        summary: 'Grupos da conta conectada, como o bot os publicou (só o proprietário)',
        security,
        headers: storeHeader,
        response: {
          200: {
            type: 'object',
            required: ['items', 'updated_at'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['id', 'name'],
                  properties: { id: { type: 'string' }, name: { type: 'string' } },
                },
              },
              updated_at: { type: 'string', format: 'date-time', nullable: true },
            },
          },
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async (request) => {
      const groups = await pairing.groups(contextOf(request));
      return { items: groups.items, updated_at: groups.updatedAt?.toISOString() ?? null };
    },
  );
}
