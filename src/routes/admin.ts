import type { FastifyInstance, FastifyReply } from 'fastify';

import type {
  AccessRequestView,
  AdminFailure,
  AdminInvitation,
  AdminService,
  AdminStore,
  AdminUser,
  InvitationKind,
} from '../admin/service.js';
import type { AuthHooks } from '../auth/hooks.js';
import { DEFAULT_LIMIT, pageQuerySchema } from '../http/pagination.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';

export interface AdminRouteDeps {
  hooks: AuthHooks;
  admin: AdminService;
}

const security = [{ bearerAuth: [] }];
const USER_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED'] as const;

const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const failures = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
} as const;

const pageOf = (item: object) =>
  ({
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: {
      items: { type: 'array', items: item },
      next_cursor: { type: 'string', nullable: true },
    },
  }) as const;

const userResponse = {
  type: 'object',
  required: [
    'id',
    'email',
    'name',
    'status',
    'can_create_stores',
    'store_limit',
    'is_platform_admin',
    'last_login_at',
    'created_at',
    'stores_count',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    name: { type: 'string', nullable: true },
    status: { type: 'string', enum: USER_STATUSES },
    can_create_stores: { type: 'boolean' },
    store_limit: { type: 'integer' },
    is_platform_admin: { type: 'boolean' },
    last_login_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    stores_count: { type: 'integer' },
  },
} as const;

const userDetailResponse = {
  ...userResponse,
  required: [...userResponse.required, 'stores'],
  properties: {
    ...userResponse.properties,
    stores: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'name', 'role'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          role: { type: 'string', enum: ['OWNER', 'STAFF'] },
        },
      },
    },
  },
} as const;

const storeResponse = {
  type: 'object',
  required: [
    'id',
    'name',
    'city',
    'plan',
    'member_limit',
    'members_count',
    'whatsapp_status',
    'owner',
    'created_at',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    city: { type: 'string', nullable: true },
    plan: { type: 'string' },
    member_limit: { type: 'integer' },
    members_count: { type: 'integer' },
    whatsapp_status: { type: 'string', enum: ['ONLINE', 'OFFLINE', 'QR_READY'] },
    owner: {
      type: 'object',
      nullable: true,
      required: ['id', 'email', 'name'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string' },
        name: { type: 'string', nullable: true },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const invitationResponse = {
  type: 'object',
  required: ['id', 'email', 'kind', 'store', 'state', 'expires_at', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    kind: { type: 'string', enum: ['ACCOUNT', 'OWNER', 'STAFF'] },
    store: {
      type: 'object',
      nullable: true,
      required: ['id', 'name'],
      properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
    },
    state: { type: 'string', enum: ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] },
    expires_at: { type: 'string', format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const requestResponse = {
  type: 'object',
  required: [
    'id',
    'name',
    'email',
    'whatsapp',
    'store_name',
    'message',
    'status',
    'decided_at',
    'converted_store_id',
    'created_at',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    name: { type: 'string' },
    email: { type: 'string' },
    whatsapp: { type: 'string', nullable: true },
    store_name: { type: 'string' },
    message: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['PENDING', 'REFUSED', 'CONVERTED'] },
    decided_at: { type: 'string', format: 'date-time', nullable: true },
    converted_store_id: { type: 'string', format: 'uuid', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const toUserJson = (u: AdminUser) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  status: u.status,
  can_create_stores: u.canCreateStores,
  store_limit: u.storeLimit,
  is_platform_admin: u.isPlatformAdmin,
  last_login_at: u.lastLoginAt?.toISOString() ?? null,
  created_at: u.createdAt.toISOString(),
  stores_count: u.storesCount,
});

const toStoreJson = (s: AdminStore) => ({
  id: s.id,
  name: s.name,
  city: s.city,
  plan: s.plan,
  member_limit: s.memberLimit,
  members_count: s.membersCount,
  whatsapp_status: s.whatsappStatus,
  owner: s.owner,
  created_at: s.createdAt.toISOString(),
});

const toInvitationJson = (i: AdminInvitation) => ({
  id: i.id,
  email: i.email,
  kind: i.kind,
  store: i.store,
  state: i.state,
  expires_at: i.expiresAt.toISOString(),
  created_at: i.createdAt.toISOString(),
});

const toRequestJson = (r: AccessRequestView) => ({
  id: r.id,
  name: r.name,
  email: r.email,
  whatsapp: r.whatsapp,
  store_name: r.storeName,
  message: r.message,
  status: r.status,
  decided_at: r.decidedAt?.toISOString() ?? null,
  converted_store_id: r.convertedStoreId,
  created_at: r.createdAt.toISOString(),
});

const FAILURES: Record<AdminFailure, [number, string]> = {
  NOT_FOUND: [404, 'Não encontrado'],
  EMAIL_TAKEN: [409, 'Já existe uma conta com este e-mail'],
  INVALID_LIMIT: [
    422,
    'Limite de lojas inválido: não pode ser negativo e exige a permissão de criar lojas',
  ],
  SELF_ACTION: [409, 'O administrador não pode fazer isto com a própria conta'],
  ADMIN_PROTECTED: [409, 'Administradores da plataforma não são suspensos por aqui'],
  NOT_SUSPENDED: [409, 'A conta não está suspensa'],
  OWNER_NOT_FOUND: [422, 'Proprietário não encontrado'],
  OWNER_NOT_ACTIVE: [422, 'O proprietário precisa ter uma conta ativa'],
  OWNER_SUSPENDED: [422, 'A conta deste e-mail está suspensa'],
  REQUEST_NOT_PENDING: [409, 'A solicitação já foi decidida'],
  ALREADY_OWNER: [409, 'Esta pessoa já é proprietária da loja'],
  NOT_PENDING: [409, 'O convite não está mais pendente'],
  TOO_SOON: [429, 'Aguarde um pouco antes de reenviar o convite'],
};

const sendFailure = (reply: FastifyReply, reason: AdminFailure) => {
  const [status, detail] = FAILURES[reason];
  return sendProblem(reply, buildProblem(status, detail, `ADMIN_${reason}`));
};

const invalidCursor = (reply: FastifyReply) =>
  sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));

/** Área `/v1/admin`: só o administrador da plataforma (ADR 0012). Nunca toca dado interno de loja. */
export function adminRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  const { hooks, admin } = deps;
  const guard = [hooks.authenticate, hooks.requirePlatformAdmin];

  const actor = (request: { auth: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    if (auth === null) throw new Error('authenticate não definiu a sessão');
    return { userId: auth.userId };
  };

  const pageOptions = (request: { query: unknown }) => {
    const q = request.query as { cursor?: string; limit?: number };
    return {
      limit: q.limit ?? DEFAULT_LIMIT,
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
    };
  };

  // --- Usuários ---------------------------------------------------------------------------------

  app.get(
    '/v1/admin/users',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminListUsers',
        tags: ['admin'],
        summary: 'Lista e busca usuários',
        security,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            q: { type: 'string', maxLength: 80, description: 'E-mail ou nome' },
            status: { type: 'string', enum: USER_STATUSES },
            can_create_stores: { type: 'boolean' },
          },
        },
        response: { 200: pageOf(userResponse), ...failures },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const result = await admin.listUsers(actor(request), {
        ...pageOptions(request),
        ...(q['q'] === undefined ? {} : { q: q['q'] as string }),
        ...(q['status'] === undefined ? {} : { status: q['status'] as AdminUser['status'] }),
        ...(q['can_create_stores'] === undefined
          ? {}
          : { canCreateStores: q['can_create_stores'] as boolean }),
      });
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return { items: result.items.map(toUserJson), next_cursor: result.nextCursor };
    },
  );

  app.get(
    '/v1/admin/users/:id',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminGetUser',
        tags: ['admin'],
        summary: 'Detalhe do usuário e das lojas em que participa (nome e papel), somente leitura',
        security,
        params: uuidParams,
        response: { 200: userDetailResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = await admin.getUser(actor(request), id);
      if (user === null) return sendFailure(reply, 'NOT_FOUND');
      return { ...toUserJson(user), stores: user.stores };
    },
  );

  app.post(
    '/v1/admin/users',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminCreateUser',
        tags: ['admin'],
        summary: 'Cadastra um usuário e envia o convite de conta (sem loja)',
        security,
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email', maxLength: 254 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            can_create_stores: { type: 'boolean', default: false },
            store_limit: { type: 'integer', minimum: 0, maximum: 1000, default: 0 },
          },
        },
        response: { 201: userResponse, ...failures },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        email: string;
        name?: string;
        can_create_stores?: boolean;
        store_limit?: number;
      };
      const result = await admin.createUser(actor(request), {
        email: body.email,
        ...(body.name === undefined ? {} : { name: body.name }),
        canCreateStores: body.can_create_stores ?? false,
        storeLimit: body.store_limit ?? 0,
      });
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.status(201).send(toUserJson(result.value));
    },
  );

  app.patch(
    '/v1/admin/users/:id/permissions',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminUpdateUserPermissions',
        tags: ['admin'],
        summary: 'Altera as permissões globais: pode criar lojas e o limite de lojas próprias',
        security,
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            can_create_stores: { type: 'boolean' },
            store_limit: { type: 'integer', minimum: 0, maximum: 1000 },
          },
        },
        response: { 200: userResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { can_create_stores?: boolean; store_limit?: number };
      const result = await admin.setPermissions(actor(request), id, {
        ...(body.can_create_stores === undefined
          ? {}
          : { canCreateStores: body.can_create_stores }),
        ...(body.store_limit === undefined ? {} : { storeLimit: body.store_limit }),
      });
      if (!result.ok) return sendFailure(reply, result.reason);
      return toUserJson(result.value);
    },
  );

  app.post(
    '/v1/admin/users/:id/suspend',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminSuspendUser',
        tags: ['admin'],
        summary: 'Suspende a conta: impede o login e derruba as sessões, sem apagar dados',
        security,
        params: uuidParams,
        response: { 200: userResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await admin.suspend(actor(request), id);
      if (!result.ok) return sendFailure(reply, result.reason);
      return toUserJson(result.value);
    },
  );

  app.post(
    '/v1/admin/users/:id/reactivate',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminReactivateUser',
        tags: ['admin'],
        summary: 'Reativa uma conta suspensa',
        security,
        params: uuidParams,
        response: { 200: userResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await admin.reactivate(actor(request), id);
      if (!result.ok) return sendFailure(reply, result.reason);
      return toUserJson(result.value);
    },
  );

  // --- Lojas ------------------------------------------------------------------------------------

  app.get(
    '/v1/admin/stores',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminListStores',
        tags: ['admin'],
        summary: 'Lista as lojas: proprietário, plano, membros e status do WhatsApp',
        security,
        querystring: {
          ...pageQuerySchema,
          properties: { ...pageQuerySchema.properties, q: { type: 'string', maxLength: 80 } },
        },
        response: { 200: pageOf(storeResponse), ...failures },
      },
    },
    async (request, reply) => {
      const q = request.query as { q?: string };
      const result = await admin.listStores(actor(request), {
        ...pageOptions(request),
        ...(q.q === undefined ? {} : { q: q.q }),
      });
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return { items: result.items.map(toStoreJson), next_cursor: result.nextCursor };
    },
  );

  app.post(
    '/v1/admin/stores',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminCreateStore',
        tags: ['admin'],
        summary:
          'Cria a loja e o proprietário (conta ativa vira OWNER; e-mail novo recebe o convite)',
        description:
          'Informe `owner_user_id` (conta ativa) **ou** `owner_email`. Com `access_request_id`, converte a solicitação de acesso.',
        security,
        body: {
          type: 'object',
          required: ['name'],
          additionalProperties: false,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120 },
            city: { type: 'string', minLength: 1, maxLength: 80, nullable: true },
            plan: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,19}$' },
            member_limit: { type: 'integer', minimum: 1, maximum: 1000 },
            owner_user_id: { type: 'string', format: 'uuid' },
            owner_email: { type: 'string', format: 'email', maxLength: 254 },
            access_request_id: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          201: {
            type: 'object',
            required: ['store', 'owner_state'],
            properties: {
              store: storeResponse,
              owner_state: { type: 'string', enum: ['MEMBER', 'INVITED'] },
            },
          },
          ...failures,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        name: string;
        city?: string | null;
        plan?: string;
        member_limit?: number;
        owner_user_id?: string;
        owner_email?: string;
        access_request_id?: string;
      };
      if ((body.owner_user_id === undefined) === (body.owner_email === undefined)) {
        return sendProblem(
          reply,
          buildProblem(400, 'Informe owner_user_id ou owner_email (um dos dois)', 'OWNER_REQUIRED'),
        );
      }
      const result = await admin.createStore(actor(request), {
        name: body.name,
        ...(body.city === undefined ? {} : { city: body.city }),
        ...(body.plan === undefined ? {} : { plan: body.plan }),
        ...(body.member_limit === undefined ? {} : { memberLimit: body.member_limit }),
        owner:
          body.owner_user_id === undefined
            ? { email: body.owner_email ?? '' }
            : { userId: body.owner_user_id },
        ...(body.access_request_id === undefined
          ? {}
          : { accessRequestId: body.access_request_id }),
      });
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.status(201).send({
        store: toStoreJson(result.value.store),
        owner_state: result.value.ownerState,
      });
    },
  );

  app.post(
    '/v1/admin/stores/:id/transfer-ownership',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminTransferOwnership',
        tags: ['admin'],
        summary:
          'Transfere a propriedade: o atual vira funcionário e a loja nunca fica sem proprietário',
        security,
        params: uuidParams,
        body: {
          type: 'object',
          required: ['new_owner_user_id'],
          additionalProperties: false,
          properties: { new_owner_user_id: { type: 'string', format: 'uuid' } },
        },
        response: { 200: storeResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { new_owner_user_id: newOwner } = request.body as { new_owner_user_id: string };
      const result = await admin.transferOwnership(actor(request), id, newOwner);
      if (!result.ok) return sendFailure(reply, result.reason);
      return toStoreJson(result.value);
    },
  );

  // --- Convites ---------------------------------------------------------------------------------

  app.get(
    '/v1/admin/invitations',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminListInvitations',
        tags: ['admin'],
        summary: 'Convites da plataforma: tipo, loja, expiração e estado',
        security,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            status: { type: 'string', enum: ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] },
            kind: { type: 'string', enum: ['ACCOUNT', 'OWNER', 'STAFF'] },
          },
        },
        response: { 200: pageOf(invitationResponse), ...failures },
      },
    },
    async (request, reply) => {
      const q = request.query as { status?: AdminInvitation['state']; kind?: InvitationKind };
      const result = await admin.listInvitations(actor(request), {
        ...pageOptions(request),
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.kind === undefined ? {} : { kind: q.kind }),
      });
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return { items: result.items.map(toInvitationJson), next_cursor: result.nextCursor };
    },
  );

  app.post(
    '/v1/admin/invitations/:id/resend',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminResendInvitation',
        tags: ['admin'],
        summary: 'Reenvia o convite (revoga o anterior e gera um token novo)',
        security,
        params: uuidParams,
        response: {
          200: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          ...failures,
          429: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await admin.resendInvitation(actor(request), id);
      if (!result.ok) return sendFailure(reply, result.reason);
      return result.value;
    },
  );

  app.delete(
    '/v1/admin/invitations/:id',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminRevokeInvitation',
        tags: ['admin'],
        summary: 'Revoga o convite pendente',
        security,
        params: uuidParams,
        response: { 204: { type: 'null' }, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await admin.revokeInvitation(actor(request), id);
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.status(204).send();
    },
  );

  // --- Solicitações de acesso -------------------------------------------------------------------

  app.get(
    '/v1/admin/access-requests',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminListAccessRequests',
        tags: ['admin'],
        summary: 'Solicitações de acesso da landing',
        security,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            status: { type: 'string', enum: ['PENDING', 'REFUSED', 'CONVERTED'] },
          },
        },
        response: { 200: pageOf(requestResponse), ...failures },
      },
    },
    async (request, reply) => {
      const q = request.query as { status?: AccessRequestView['status'] };
      const result = await admin.listAccessRequests(actor(request), {
        ...pageOptions(request),
        ...(q.status === undefined ? {} : { status: q.status }),
      });
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return { items: result.items.map(toRequestJson), next_cursor: result.nextCursor };
    },
  );

  app.post(
    '/v1/admin/access-requests/:id/refuse',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminRefuseAccessRequest',
        tags: ['admin'],
        summary:
          'Recusa a solicitação (não envia nada ao solicitante). Para aprovar, crie a loja com access_request_id',
        security,
        params: uuidParams,
        response: { 204: { type: 'null' }, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await admin.refuseAccessRequest(actor(request), id);
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.status(204).send();
    },
  );

  // --- Painel e log -----------------------------------------------------------------------------

  app.get(
    '/v1/admin/dashboard',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminDashboard',
        tags: ['admin'],
        summary: 'KPIs da plataforma e lojas com WhatsApp desconectado (só acompanhamento)',
        security,
        response: {
          200: {
            type: 'object',
            required: ['kpis', 'disconnected_stores'],
            properties: {
              kpis: {
                type: 'object',
                required: ['active_users', 'stores', 'pending_invitations', 'new_access_requests'],
                properties: {
                  active_users: { type: 'integer' },
                  stores: { type: 'integer' },
                  pending_invitations: { type: 'integer' },
                  new_access_requests: { type: 'integer' },
                },
              },
              disconnected_stores: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    name: { type: 'string' },
                    city: { type: 'string', nullable: true },
                    whatsapp_status: { type: 'string', enum: ['OFFLINE', 'QR_READY'] },
                  },
                },
              },
            },
          },
          ...failures,
        },
      },
    },
    async (request) => {
      const o = await admin.overview(actor(request));
      return {
        kpis: {
          active_users: o.activeUsers,
          stores: o.stores,
          pending_invitations: o.pendingInvitations,
          new_access_requests: o.newAccessRequests,
        },
        disconnected_stores: o.disconnectedStores.map((s) => ({
          id: s.id,
          name: s.name,
          city: s.city,
          whatsapp_status: s.whatsappStatus,
        })),
      };
    },
  );

  app.get(
    '/v1/admin/activity-log',
    {
      preValidation: guard,
      schema: {
        operationId: 'adminActivityLog',
        tags: ['admin'],
        summary: 'Log de atividades da plataforma',
        security,
        querystring: pageQuerySchema,
        response: {
          200: pageOf({
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              created_at: { type: 'string', format: 'date-time' },
              actor_user_id: { type: 'string', format: 'uuid', nullable: true },
              action: { type: 'string' },
              target_type: { type: 'string', nullable: true },
              target_id: { type: 'string', format: 'uuid', nullable: true },
              details: { type: 'object', additionalProperties: true },
            },
          }),
          ...failures,
        },
      },
    },
    async (request, reply) => {
      const result = await admin.activityLog(actor(request), pageOptions(request));
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return {
        items: result.items.map((e) => ({
          id: e.id,
          created_at: e.createdAt.toISOString(),
          actor_user_id: e.actorUserId,
          action: e.action,
          target_type: e.targetType,
          target_id: e.targetId,
          details: e.details,
        })),
        next_cursor: result.nextCursor,
      };
    },
  );
}
