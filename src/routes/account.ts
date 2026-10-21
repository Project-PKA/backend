import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import { DEFAULT_LIMIT, pageQuerySchema } from '../http/pagination.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import type { NotificationService, NotificationView } from '../notifications/service.js';
import type { PlanOverview, PlanRequestView, PlanService } from '../plan/service.js';
import {
  CURRENCIES,
  LANGUAGES,
  THEMES,
  type Preferences,
  type PreferencesPatch,
  type ProfileService,
} from '../profile/service.js';
import { storeHeader } from './store.js';

export interface AccountRouteDeps {
  hooks: AuthHooks;
  profile: ProfileService;
  notifications: NotificationService;
  plan: PlanService;
}

const security = [{ bearerAuth: [] }];

const failures = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
} as const;

const preferencesSchema = {
  type: 'object',
  required: ['language', 'theme', 'timezone', 'currency', 'notifications'],
  properties: {
    language: { type: 'string', enum: LANGUAGES },
    theme: { type: 'string', enum: THEMES },
    timezone: { type: 'string', description: 'Fuso IANA, ex.: America/Sao_Paulo' },
    currency: { type: 'string', enum: CURRENCIES },
    notifications: {
      type: 'object',
      required: ['in_app', 'email'],
      properties: { in_app: { type: 'boolean' }, email: { type: 'boolean' } },
    },
  },
} as const;

const toPreferencesJson = (p: Preferences) => ({
  language: p.language,
  theme: p.theme,
  timezone: p.timezone,
  currency: p.currency,
  notifications: { in_app: p.notifications.inApp, email: p.notifications.email },
});

const planRequestSchema = {
  type: 'object',
  required: ['id', 'requested_plan', 'message', 'status', 'decided_at', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    requested_plan: { type: 'string', nullable: true },
    message: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['PENDING', 'APPLIED', 'REFUSED'] },
    decided_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const toPlanRequestJson = (r: PlanRequestView) => ({
  id: r.id,
  requested_plan: r.requestedPlan,
  message: r.message,
  status: r.status,
  decided_at: r.decidedAt?.toISOString() ?? null,
  created_at: r.createdAt.toISOString(),
});

const toNotificationJson = (n: NotificationView) => ({
  id: n.id,
  kind: n.kind,
  data: n.data,
  read: n.read,
  created_at: n.createdAt.toISOString(),
});

const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

/** Perfil (preferências), notificações internas e plano da loja. */
export function accountRoutes(app: FastifyInstance, deps: AccountRouteDeps): void {
  const { hooks, profile, notifications, plan } = deps;
  const user = [hooks.authenticate];
  const member = [hooks.authenticate, hooks.requireStore];
  const owner = [...member, hooks.requireOwner];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };
  const userIdOf = (request: { auth: unknown }): string => {
    const auth = request.auth as { userId: string } | null;
    if (auth === null) throw new Error('authenticate não definiu a sessão');
    return auth.userId;
  };

  // --- Perfil -----------------------------------------------------------------------------------

  app.get(
    '/v1/me/preferences',
    {
      preValidation: user,
      schema: {
        operationId: 'getPreferences',
        tags: ['me'],
        summary: 'Preferências do perfil: idioma, tema, fuso, moeda e notificações',
        security,
        response: { 200: preferencesSchema, ...failures },
      },
    },
    async (request, reply) => {
      const found = await profile.get(userIdOf(request));
      if (found === null) {
        return sendProblem(reply, buildProblem(404, 'Conta não encontrada', 'USER_NOT_FOUND'));
      }
      return toPreferencesJson(found);
    },
  );

  app.patch(
    '/v1/me/preferences',
    {
      preValidation: user,
      schema: {
        operationId: 'updatePreferences',
        tags: ['me'],
        summary: 'Altera as preferências do perfil (só o que for enviado)',
        security,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            language: { type: 'string', enum: LANGUAGES },
            theme: { type: 'string', enum: THEMES },
            timezone: { type: 'string', minLength: 1, maxLength: 64 },
            currency: { type: 'string', enum: CURRENCIES },
            notifications: {
              type: 'object',
              additionalProperties: false,
              minProperties: 1,
              properties: { in_app: { type: 'boolean' }, email: { type: 'boolean' } },
            },
          },
        },
        response: { 200: preferencesSchema, ...failures },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        language?: Preferences['language'];
        theme?: Preferences['theme'];
        timezone?: string;
        currency?: Preferences['currency'];
        notifications?: { in_app?: boolean; email?: boolean };
      };
      const patch: PreferencesPatch = {
        ...(body.language === undefined ? {} : { language: body.language }),
        ...(body.theme === undefined ? {} : { theme: body.theme }),
        ...(body.timezone === undefined ? {} : { timezone: body.timezone }),
        ...(body.currency === undefined ? {} : { currency: body.currency }),
        ...(body.notifications === undefined
          ? {}
          : {
              notifications: {
                ...(body.notifications.in_app === undefined
                  ? {}
                  : { inApp: body.notifications.in_app }),
                ...(body.notifications.email === undefined
                  ? {}
                  : { email: body.notifications.email }),
              },
            }),
      };
      const updated = await profile.update(userIdOf(request), patch);
      if (updated === 'INVALID_TIMEZONE') {
        return sendProblem(reply, buildProblem(422, 'Fuso horário inválido', 'INVALID_TIMEZONE'));
      }
      if (updated === null) {
        return sendProblem(reply, buildProblem(404, 'Conta não encontrada', 'USER_NOT_FOUND'));
      }
      return toPreferencesJson(updated);
    },
  );

  // --- Notificações -----------------------------------------------------------------------------

  app.get(
    '/v1/notifications',
    {
      preValidation: member,
      schema: {
        operationId: 'listNotifications',
        tags: ['notifications'],
        summary: 'Avisos internos da loja, do mais novo para o mais antigo',
        description:
          'O texto é do frontend: aqui vêm só o código (`kind`) e ids em `data`. Os `kind` que a API cria hoje: ' +
          '`POLL_CEILING_REACHED` (`data.auction_id`: o lance de uma enquete chegou ao teto e o leilão espera validação) e ' +
          '`BUYER_DATA_SUBMITTED` (`data.settlement_id` e `data.customer_id`: o comprador preencheu os dados do acerto). ' +
          'Um `kind` novo pode surgir sem aviso; mostre um texto genérico para os que não conhece.',
        security,
        headers: storeHeader,
        querystring: {
          ...pageQuerySchema,
          properties: { ...pageQuerySchema.properties, unread: { type: 'boolean' } },
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
                  required: ['id', 'kind', 'data', 'read', 'created_at'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    kind: { type: 'string' },
                    data: { type: 'object', additionalProperties: true },
                    read: { type: 'boolean' },
                    created_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
              next_cursor: { type: 'string', nullable: true },
            },
          },
          ...failures,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { cursor?: string; limit?: number; unread?: boolean };
      const result = await notifications.list(contextOf(request), {
        limit: q.limit ?? DEFAULT_LIMIT,
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.unread === undefined ? {} : { unread: q.unread }),
      });
      if (result === 'INVALID_CURSOR') {
        return sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));
      }
      return { items: result.items.map(toNotificationJson), next_cursor: result.nextCursor };
    },
  );

  app.get(
    '/v1/notifications/unread-count',
    {
      preValidation: member,
      schema: {
        operationId: 'countUnreadNotifications',
        tags: ['notifications'],
        summary: 'Quantos avisos você ainda não leu',
        security,
        headers: storeHeader,
        response: {
          200: { type: 'object', required: ['count'], properties: { count: { type: 'integer' } } },
          ...failures,
        },
      },
    },
    async (request) => ({ count: await notifications.unreadCount(contextOf(request)) }),
  );

  app.post(
    '/v1/notifications/read-all',
    {
      preValidation: member,
      schema: {
        operationId: 'markAllNotificationsRead',
        tags: ['notifications'],
        summary: 'Marca todos os avisos da loja como lidos (para você)',
        security,
        headers: storeHeader,
        response: {
          200: {
            type: 'object',
            required: ['marked'],
            properties: { marked: { type: 'integer' } },
          },
          ...failures,
        },
      },
    },
    async (request) => ({ marked: await notifications.markAllRead(contextOf(request)) }),
  );

  app.post(
    '/v1/notifications/:id/read',
    {
      preValidation: member,
      schema: {
        operationId: 'markNotificationRead',
        tags: ['notifications'],
        summary: 'Marca um aviso como lido (para você)',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: { 204: { type: 'null' }, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await notifications.markRead(contextOf(request), id);
      if (!found) {
        return sendProblem(
          reply,
          buildProblem(404, 'Aviso não encontrado', 'NOTIFICATION_NOT_FOUND'),
        );
      }
      return reply.status(204).send();
    },
  );

  // --- Plano ------------------------------------------------------------------------------------

  const overviewSchema = {
    type: 'object',
    required: ['plan', 'limits', 'usage', 'pending_request', 'recent_requests'],
    properties: {
      plan: { type: 'string' },
      limits: {
        type: 'object',
        required: ['members', 'cards', 'groups'],
        properties: {
          members: { type: 'integer' },
          cards: { type: 'integer', nullable: true, description: 'Sem valor = ilimitado' },
          groups: { type: 'integer' },
        },
      },
      usage: {
        type: 'object',
        required: ['members', 'pending_invitations', 'cards', 'groups'],
        properties: {
          members: { type: 'integer' },
          pending_invitations: { type: 'integer' },
          cards: { type: 'integer' },
          groups: { type: 'integer' },
        },
      },
      pending_request: { ...planRequestSchema, nullable: true },
      recent_requests: { type: 'array', items: planRequestSchema },
    },
  } as const;

  const toOverviewJson = (o: PlanOverview) => ({
    plan: o.plan,
    limits: o.limits,
    usage: {
      members: o.usage.members,
      pending_invitations: o.usage.pendingInvitations,
      cards: o.usage.cards,
      groups: o.usage.groups,
    },
    pending_request: o.pendingRequest === null ? null : toPlanRequestJson(o.pendingRequest),
    recent_requests: o.recentRequests.map(toPlanRequestJson),
  });

  app.get(
    '/v1/plan',
    {
      preValidation: member,
      schema: {
        operationId: 'getPlan',
        tags: ['plan'],
        summary: 'Plano atual, limites, uso (grupos, membros, cartas) e pedidos de mudança',
        description:
          'A cobrança e as faturas dependem da decisão D6 e ainda não existem. A mudança de plano é pedida à administração.',
        security,
        headers: storeHeader,
        response: { 200: overviewSchema, ...failures },
      },
    },
    async (request) => toOverviewJson(await plan.overview(contextOf(request))),
  );

  app.post(
    '/v1/plan/change-requests',
    {
      preValidation: owner,
      schema: {
        operationId: 'requestPlanChange',
        tags: ['plan'],
        summary: 'Pede à administração a mudança de plano (só o proprietário)',
        description: 'Há um pedido pendente por loja: pedir de novo atualiza o que está na fila.',
        security,
        headers: storeHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            requested_plan: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,19}$' },
            message: { type: 'string', minLength: 1, maxLength: 1000 },
          },
        },
        response: { 201: planRequestSchema, ...failures },
      },
    },
    async (request, reply) => {
      const body = (request.body ?? {}) as { requested_plan?: string; message?: string };
      const created = await plan.requestChange(contextOf(request), {
        ...(body.requested_plan === undefined ? {} : { requestedPlan: body.requested_plan }),
        ...(body.message === undefined ? {} : { message: body.message }),
      });
      return reply.status(201).send(toPlanRequestJson(created));
    },
  );
}
