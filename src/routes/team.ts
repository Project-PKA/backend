import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import type { InvitationItem, InvitationService } from '../auth/invitations.js';
import { PERMISSIONS, type Permission } from '../auth/permissions.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import { DEFAULT_LIMIT, pageQuerySchema } from '../http/pagination.js';
import type { TeamMember, TeamService } from '../team/service.js';
import { storeHeader } from './store.js';

export interface TeamRouteDeps {
  hooks: AuthHooks;
  team: TeamService;
  invitations: InvitationService;
}

const security = [{ bearerAuth: [] }];
const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const permissionsInput = {
  type: 'object',
  additionalProperties: false,
  description: 'Só as chaves conhecidas; as demais são descartadas',
  properties: Object.fromEntries(PERMISSIONS.map((key) => [key, { type: 'boolean' }])),
} as const;

const permissionsOutput = {
  type: 'object',
  additionalProperties: { type: 'boolean' },
} as const;

const memberResponse = {
  type: 'object',
  required: ['id', 'user_id', 'email', 'name', 'role', 'permissions', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    user_id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    name: { type: 'string', nullable: true },
    role: { type: 'string', enum: ['OWNER', 'STAFF'] },
    permissions: permissionsOutput,
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const invitationResponse = {
  type: 'object',
  required: ['id', 'email', 'role', 'permissions', 'state', 'expires_at', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    role: { type: 'string', enum: ['OWNER', 'STAFF'], nullable: true },
    permissions: permissionsOutput,
    state: { type: 'string', enum: ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] },
    expires_at: { type: 'string', format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const toMember = (member: TeamMember) => ({
  id: member.id,
  user_id: member.userId,
  email: member.email,
  name: member.name,
  role: member.role,
  permissions: member.permissions,
  created_at: member.createdAt.toISOString(),
});

const toInvitation = (item: InvitationItem) => ({
  id: item.id,
  email: item.email,
  role: item.role,
  permissions: item.permissions,
  state: item.state,
  expires_at: item.expiresAt.toISOString(),
  created_at: item.createdAt.toISOString(),
});

const invalidCursor = (reply: Parameters<typeof sendProblem>[0]) =>
  sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));

export function teamRoutes(app: FastifyInstance, deps: TeamRouteDeps): void {
  const { hooks, team, invitations } = deps;
  const member = [hooks.authenticate, hooks.requireStore];
  const owner = [hooks.authenticate, hooks.requireStore, hooks.requireOwner];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };

  app.post(
    '/v1/store/permission-requests',
    {
      preValidation: member,
      schema: {
        operationId: 'requestPermission',
        tags: ['team'],
        summary: 'Pede uma permissão ao proprietário da loja',
        description:
          'Para o botão "Pedir acesso ao proprietário". Não concede nada: avisa o proprietário na central de avisos ' +
          '(`kind` `PERMISSION_REQUESTED`, com `data.user_id` e `data.permission`) e registra no log de atividades. ' +
          'A mesma pessoa só pode repetir o mesmo pedido depois de 24 horas.',
        security,
        headers: storeHeader,
        body: {
          type: 'object',
          required: ['permission'],
          additionalProperties: false,
          properties: { permission: { type: 'string', enum: PERMISSIONS } },
        },
        response: {
          201: {
            type: 'object',
            required: ['permission', 'requested_at'],
            properties: {
              permission: { type: 'string', enum: PERMISSIONS },
              requested_at: { type: 'string', format: 'date-time' },
            },
          },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          409: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const tenant = request.tenant;
      if (tenant === null) throw new Error('hooks não definiram o contexto');
      const { permission } = request.body as { permission: Permission };
      const result = await team.requestPermission(
        contextOf(request),
        tenant.permissions,
        permission,
      );
      if (result.ok) {
        return reply
          .status(201)
          .send({ permission: result.permission, requested_at: result.requestedAt.toISOString() });
      }
      return result.reason === 'ALREADY_GRANTED'
        ? sendProblem(
            reply,
            buildProblem(409, 'Você já tem esta permissão', 'PERMISSION_ALREADY_GRANTED'),
          )
        : sendProblem(
            reply,
            buildProblem(
              429,
              'Você já pediu esta permissão hoje. Aguarde a resposta do proprietário',
              'PERMISSION_REQUEST_TOO_SOON',
            ),
          );
    },
  );

  app.get(
    '/v1/team',
    {
      preValidation: member,
      schema: {
        operationId: 'listTeam',
        tags: ['team'],
        summary: 'Equipe da loja, com papel e permissões efetivas',
        security,
        headers: storeHeader,
        querystring: pageQuerySchema,
        response: {
          200: {
            type: 'object',
            required: ['items', 'next_cursor'],
            properties: {
              items: { type: 'array', items: memberResponse },
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
      const query = request.query as { cursor?: string; limit?: number };
      const result = await team.list(contextOf(request), {
        limit: query.limit ?? DEFAULT_LIMIT,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return { items: result.items.map(toMember), next_cursor: result.nextCursor };
    },
  );

  app.patch(
    '/v1/team/:id',
    {
      preValidation: owner,
      schema: {
        operationId: 'updateTeamMemberPermissions',
        tags: ['team'],
        summary: 'Ajusta as permissões de um funcionário (só o proprietário)',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          required: ['permissions'],
          additionalProperties: false,
          properties: { permissions: permissionsInput },
        },
        response: {
          200: memberResponse,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { permissions } = request.body as { permissions: unknown };
      const result = await team.updatePermissions(contextOf(request), id, permissions);
      if (result.ok) return toMember(result.member);
      return result.reason === 'NOT_FOUND'
        ? sendProblem(reply, buildProblem(404, 'Membro não encontrado', 'MEMBER_NOT_FOUND'))
        : sendProblem(
            reply,
            buildProblem(409, 'O proprietário tem todas as permissões', 'OWNER_PERMISSIONS_FIXED'),
          );
    },
  );

  app.delete(
    '/v1/team/:id',
    {
      preValidation: owner,
      schema: {
        operationId: 'removeTeamMember',
        tags: ['team'],
        summary: 'Remove um membro (nunca deixa a loja sem proprietário)',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: {
          204: { type: 'null' },
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await team.remove(contextOf(request), id);
      if (result.ok) return reply.status(204).send();
      return result.reason === 'NOT_FOUND'
        ? sendProblem(reply, buildProblem(404, 'Membro não encontrado', 'MEMBER_NOT_FOUND'))
        : sendProblem(
            reply,
            buildProblem(409, 'A loja precisa de ao menos um proprietário', 'LAST_OWNER'),
          );
    },
  );

  app.get(
    '/v1/team/invitations',
    {
      preValidation: owner,
      schema: {
        operationId: 'listTeamInvitations',
        tags: ['team'],
        summary: 'Convites da loja (só o proprietário)',
        security,
        headers: storeHeader,
        querystring: pageQuerySchema,
        response: {
          200: {
            type: 'object',
            required: ['items', 'next_cursor'],
            properties: {
              items: { type: 'array', items: invitationResponse },
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
      const query = request.query as { cursor?: string; limit?: number };
      const { storeId } = contextOf(request);
      const result = await invitations.listForStore(
        { storeId },
        {
          limit: query.limit ?? DEFAULT_LIMIT,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        },
      );
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return { items: result.items.map(toInvitation), next_cursor: result.nextCursor };
    },
  );

  app.post(
    '/v1/team/invitations',
    {
      preValidation: owner,
      schema: {
        operationId: 'inviteTeamMember',
        tags: ['team'],
        summary: 'Convida um funcionário por e-mail (só o proprietário)',
        description:
          'A resposta é a mesma exista ou não conta para o e-mail. O convite chega por e-mail, ' +
          'com o token no fragmento do link.',
        security,
        headers: storeHeader,
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            permissions: permissionsInput,
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['id', 'expires_at'],
            properties: {
              id: { type: 'string', format: 'uuid' },
              expires_at: { type: 'string', format: 'date-time' },
            },
          },
          401: problemSchema,
          403: problemSchema,
          409: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { storeId, userId } = contextOf(request);
      const body = request.body as { email: string; permissions?: unknown };
      const result = await invitations.create({
        email: body.email,
        storeId,
        role: 'STAFF',
        permissions: body.permissions,
        invitedBy: userId,
      });
      if (result.ok) {
        return reply
          .status(201)
          .send({ id: result.invitationId, expires_at: result.expiresAt.toISOString() });
      }
      if (result.reason === 'MEMBER_LIMIT') {
        return sendProblem(
          reply,
          buildProblem(
            409,
            'A loja atingiu o limite de membros do plano. Fale com a administração',
            'MEMBER_LIMIT_REACHED',
          ),
        );
      }
      return result.reason === 'ALREADY_MEMBER'
        ? sendProblem(
            reply,
            buildProblem(409, 'Essa pessoa já faz parte da loja', 'ALREADY_MEMBER'),
          )
        : sendProblem(
            reply,
            buildProblem(422, 'Não é possível convidar este e-mail', 'INVITATION_NOT_ALLOWED'),
          );
    },
  );

  app.post(
    '/v1/team/invitations/:id/resend',
    {
      preValidation: owner,
      schema: {
        operationId: 'resendTeamInvitation',
        tags: ['team'],
        summary: 'Reenvia um convite pendente, com token novo (o anterior deixa de valer)',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: {
          201: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          409: problemSchema,
          422: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await invitations.resend(contextOf(request), id);
      if (result.ok) return reply.status(201).send({ id: result.invitationId });
      switch (result.reason) {
        case 'NOT_FOUND':
          return sendProblem(
            reply,
            buildProblem(404, 'Convite não encontrado', 'INVITATION_NOT_FOUND'),
          );
        case 'NOT_PENDING':
          return sendProblem(
            reply,
            buildProblem(409, 'O convite não está pendente', 'INVITATION_NOT_PENDING'),
          );
        case 'TOO_SOON':
          return sendProblem(reply, buildProblem(429, 'Aguarde para reenviar', 'RESEND_TOO_SOON'));
        default:
          return sendProblem(
            reply,
            buildProblem(422, 'Não é possível convidar este e-mail', 'INVITATION_NOT_ALLOWED'),
          );
      }
    },
  );

  app.delete(
    '/v1/team/invitations/:id',
    {
      preValidation: owner,
      schema: {
        operationId: 'revokeTeamInvitation',
        tags: ['team'],
        summary: 'Revoga um convite pendente: o link deixa de funcionar na hora',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: {
          204: { type: 'null' },
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const revoked = await invitations.revoke(contextOf(request), id);
      if (!revoked) {
        return sendProblem(
          reply,
          buildProblem(404, 'Convite não encontrado', 'INVITATION_NOT_FOUND'),
        );
      }
      return reply.status(204).send();
    },
  );
}
