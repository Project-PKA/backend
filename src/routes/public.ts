import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import { normalizeCep, normalizeCpf } from '../customers/validation.js';
import { DEFAULT_LIMIT, pageQuerySchema } from '../http/pagination.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import type { PublicAccessService } from '../public/access.js';
import type { LinkKind, LinkView, PublicLinkService } from '../public/links.js';
import { storeHeader } from './store.js';

export interface PublicRouteDeps {
  access: PublicAccessService;
  /** Requisições por minuto e por IP nas rotas públicas. */
  rateLimitPerMinute: number;
}

export interface PublicLinkRouteDeps {
  hooks: AuthHooks;
  links: PublicLinkService;
}

const TOKEN = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' } as const;

/**
 * Resposta única para link inexistente, expirado, revogado, bloqueado ou com chave errada: o
 * atacante não aprende nada sobre o que existe (ADR 0014).
 */
const notFound = (reply: FastifyReply) =>
  sendProblem(reply, buildProblem(404, 'Link inválido ou expirado', 'PUBLIC_LINK_NOT_FOUND'));

const invalidData = (reply: FastifyReply, code: string, detail: string) =>
  sendProblem(reply, buildProblem(422, detail, code));

const failures = {
  400: problemSchema,
  404: problemSchema,
  422: problemSchema,
  429: problemSchema,
} as const;

/** Rotas SEM login. O token nunca vai na URL: vem no corpo, para não parar em log nem em Referer. */
export function publicRoutes(app: FastifyInstance, deps: PublicRouteDeps): void {
  const { access } = deps;
  const rateLimit = { max: deps.rateLimitPerMinute, timeWindow: '1 minute' };

  void app.register((scope, _options, done) => {
    scope.addHook('onSend', (_request, reply, payload, next) => {
      void reply.header('Cache-Control', 'no-store');
      void reply.header('Referrer-Policy', 'no-referrer');
      void reply.header('X-Robots-Tag', 'noindex, nofollow');
      next(null, payload);
    });

    scope.post(
      '/v1/public/settlement',
      {
        config: { rateLimit },
        schema: {
          operationId: 'publicSettlementView',
          tags: ['public'],
          summary: 'Página pública do acerto (o token vem no corpo)',
          description:
            'Sem login. Resposta igual para link inválido, expirado ou revogado. A plataforma não cobra nem garante o pagamento.',
          body: {
            type: 'object',
            required: ['token'],
            additionalProperties: false,
            properties: { token: TOKEN },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: true,
              properties: {
                store_name: { type: 'string' },
                pix_key: { type: 'string', nullable: true },
                status: { type: 'string', enum: ['PENDING', 'PAID'] },
                shipping_cost: { type: 'string' },
                total_amount: { type: 'string' },
                expires_at: { type: 'string' },
                items: { type: 'array', items: { type: 'object', additionalProperties: true } },
                buyer: { type: 'object', additionalProperties: true },
              },
            },
            ...failures,
          },
        },
      },
      async (request, reply) => {
        const { token } = request.body as { token: string };
        const page = await access.settlement(token, request.ip);
        return page === null ? notFound(reply) : page;
      },
    );

    scope.post(
      '/v1/public/settlement/data',
      {
        config: { rateLimit },
        schema: {
          operationId: 'publicSettlementSubmit',
          tags: ['public'],
          summary: 'O comprador informa CPF e endereço, com consentimento LGPD',
          body: {
            type: 'object',
            required: ['token', 'cpf', 'address', 'consent'],
            additionalProperties: false,
            properties: {
              token: TOKEN,
              cpf: { type: 'string', maxLength: 14 },
              address: {
                type: 'object',
                required: ['zip', 'street', 'number', 'city', 'state'],
                additionalProperties: false,
                properties: {
                  zip: { type: 'string', maxLength: 9 },
                  street: { type: 'string', minLength: 1, maxLength: 120 },
                  number: { type: 'string', minLength: 1, maxLength: 20 },
                  comp: { type: 'string', maxLength: 60, nullable: true },
                  city: { type: 'string', minLength: 1, maxLength: 80 },
                  state: { type: 'string', pattern: '^[A-Za-z]{2}$' },
                },
              },
              consent: {
                type: 'object',
                required: ['accepted', 'version'],
                additionalProperties: false,
                properties: {
                  accepted: { type: 'boolean' },
                  version: { type: 'string', minLength: 1, maxLength: 40 },
                },
              },
            },
          },
          response: {
            200: {
              type: 'object',
              required: ['result'],
              properties: { result: { type: 'string', enum: ['OK'] } },
            },
            ...failures,
          },
        },
      },
      async (request, reply) => {
        const body = request.body as {
          token: string;
          cpf: string;
          address: {
            zip: string;
            street: string;
            number: string;
            comp?: string | null;
            city: string;
            state: string;
          };
          consent: { accepted: boolean; version: string };
        };
        if (!body.consent.accepted) {
          return invalidData(
            reply,
            'PUBLIC_CONSENT_REQUIRED',
            'É preciso aceitar o termo de consentimento',
          );
        }
        const cpf = normalizeCpf(body.cpf);
        const zip = normalizeCep(body.address.zip);
        if (cpf === null) return invalidData(reply, 'PUBLIC_CPF_INVALID', 'CPF inválido');
        if (zip === null) return invalidData(reply, 'PUBLIC_CEP_INVALID', 'CEP inválido');

        const outcome = await access.submitBuyerData(body.token, request.ip, {
          cpf,
          zip,
          street: body.address.street.trim(),
          number: body.address.number.trim(),
          comp: body.address.comp ?? null,
          city: body.address.city.trim(),
          state: body.address.state.toUpperCase(),
          consentVersion: body.consent.version,
        });
        if (outcome === null) return notFound(reply);
        if (outcome === 'CONSENT_REQUIRED') {
          return invalidData(
            reply,
            'PUBLIC_CONSENT_REQUIRED',
            'É preciso aceitar o termo de consentimento',
          );
        }
        if (outcome === 'INVALID_DATA') {
          return invalidData(reply, 'PUBLIC_DATA_INVALID', 'Dados inválidos');
        }
        return { result: 'OK' };
      },
    );

    scope.post(
      '/v1/public/consignor',
      {
        config: { rateLimit },
        schema: {
          operationId: 'publicConsignorView',
          tags: ['public'],
          summary: 'Acompanhamento do consignador (token + 4 primeiros dígitos do CPF)',
          description:
            'Chave errada responde igual a link inválido. 5 erros bloqueiam o link por 15 minutos. O repasse é só estimativa.',
          body: {
            type: 'object',
            required: ['token', 'key'],
            additionalProperties: false,
            properties: { token: TOKEN, key: { type: 'string', pattern: '^[0-9]{4}$' } },
          },
          response: {
            200: {
              type: 'object',
              additionalProperties: true,
              properties: {
                store_name: { type: 'string' },
                first_name: { type: 'string' },
                expires_at: { type: 'string' },
                estimate_is_final: { type: 'boolean' },
                cards: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
            },
            ...failures,
          },
        },
      },
      async (request, reply) => {
        const { token, key } = request.body as { token: string; key: string };
        const page = await access.consignor(token, key, request.ip);
        return page === null ? notFound(reply) : page;
      },
    );

    done();
  });
}

const security = [{ bearerAuth: [] }];

const linkResponse = {
  type: 'object',
  required: ['id', 'kind', 'settlement_id', 'customer_id', 'state', 'expires_at', 'created_at'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    kind: { type: 'string', enum: ['SETTLEMENT', 'CONSIGNOR'] },
    settlement_id: { type: 'string', format: 'uuid', nullable: true },
    customer_id: { type: 'string', format: 'uuid', nullable: true },
    state: { type: 'string', enum: ['ACTIVE', 'EXPIRED', 'REVOKED', 'LOCKED'] },
    expires_at: { type: 'string', format: 'date-time' },
    locked_until: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const toLinkJson = (link: LinkView) => ({
  id: link.id,
  kind: link.kind,
  settlement_id: link.settlementId,
  customer_id: link.customerId,
  state: link.state,
  expires_at: link.expiresAt.toISOString(),
  locked_until: link.lockedUntil?.toISOString() ?? null,
  created_at: link.createdAt.toISOString(),
});

const createdLinkResponse = {
  type: 'object',
  required: ['link', 'token'],
  properties: {
    link: linkResponse,
    token: {
      type: 'string',
      description:
        'Aparece UMA vez. Monte o link com ele no fragmento (#token=...); a plataforma só guarda o hash.',
    },
  },
} as const;

const expiresBody = (days: number) =>
  ({
    type: 'object',
    additionalProperties: false,
    properties: { expires_in_days: { type: 'integer', minimum: 1, maximum: 90, default: days } },
  }) as const;

const authFailures = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  422: problemSchema,
} as const;

/** Rotas COM login: a loja gera, lista e revoga os links públicos. */
export function publicLinkRoutes(app: FastifyInstance, deps: PublicLinkRouteDeps): void {
  const { hooks, links } = deps;
  const member = [hooks.authenticate, hooks.requireStore];
  const settlements = [...member, hooks.requirePermission('can_manage_auctions')];
  const consignors = [...member, hooks.requirePermission('can_manage_customers')];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };

  const params = {
    type: 'object',
    required: ['id'],
    properties: { id: { type: 'string', format: 'uuid' } },
  } as const;

  app.post(
    '/v1/settlements/:id/public-link',
    {
      preValidation: settlements,
      schema: {
        operationId: 'createSettlementLink',
        tags: ['public'],
        summary: 'Gera o link da página pública do acerto (revoga o anterior)',
        security,
        headers: storeHeader,
        params,
        body: expiresBody(14),
        response: { 201: createdLinkResponse, ...authFailures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { expires_in_days: days } = (request.body ?? {}) as { expires_in_days?: number };
      const result = await links.create(
        contextOf(request),
        { kind: 'SETTLEMENT', settlementId: id },
        days ?? 14,
      );
      if (!result.ok) {
        return sendProblem(
          reply,
          buildProblem(404, 'Acerto não encontrado', 'SETTLEMENT_NOT_FOUND'),
        );
      }
      return reply.status(201).send({ link: toLinkJson(result.link), token: result.token });
    },
  );

  app.post(
    '/v1/customers/:id/consignor-link',
    {
      preValidation: consignors,
      schema: {
        operationId: 'createConsignorLink',
        tags: ['public'],
        summary: 'Gera o link de acompanhamento do consignador (exige CPF cadastrado)',
        description:
          'A chave de acesso são os 4 primeiros dígitos do CPF dele. Sem CPF, o link não é gerado.',
        security,
        headers: storeHeader,
        params,
        body: expiresBody(30),
        response: { 201: createdLinkResponse, ...authFailures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { expires_in_days: days } = (request.body ?? {}) as { expires_in_days?: number };
      const result = await links.create(
        contextOf(request),
        { kind: 'CONSIGNOR', customerId: id },
        days ?? 30,
      );
      if (!result.ok) {
        return result.reason === 'NOT_FOUND'
          ? sendProblem(reply, buildProblem(404, 'Cliente não encontrado', 'CUSTOMER_NOT_FOUND'))
          : sendProblem(
              reply,
              buildProblem(
                422,
                'Cadastre o CPF do consignador antes de gerar o link',
                'CONSIGNOR_CPF_REQUIRED',
              ),
            );
      }
      return reply.status(201).send({ link: toLinkJson(result.link), token: result.token });
    },
  );

  app.get(
    '/v1/public-links',
    {
      preValidation: member,
      schema: {
        operationId: 'listPublicLinks',
        tags: ['public'],
        summary: 'Links públicos da loja e o estado de cada um (nunca o token)',
        security,
        headers: storeHeader,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            kind: { type: 'string', enum: ['SETTLEMENT', 'CONSIGNOR'] },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['items', 'next_cursor'],
            properties: {
              items: { type: 'array', items: linkResponse },
              next_cursor: { type: 'string', nullable: true },
            },
          },
          ...authFailures,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as { cursor?: string; limit?: number; kind?: LinkKind };
      const result = await links.list(contextOf(request), {
        limit: q.limit ?? DEFAULT_LIMIT,
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.kind === undefined ? {} : { kind: q.kind }),
      });
      if (result === 'INVALID_CURSOR') {
        return sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));
      }
      return { items: result.items.map(toLinkJson), next_cursor: result.nextCursor };
    },
  );

  app.delete(
    '/v1/public-links/:id',
    {
      preValidation: member,
      schema: {
        operationId: 'revokePublicLink',
        tags: ['public'],
        summary: 'Revoga o link na hora',
        security,
        headers: storeHeader,
        params,
        response: { 200: linkResponse, ...authFailures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const link = await links.revoke(contextOf(request), id);
      if (link === null) {
        return sendProblem(
          reply,
          buildProblem(404, 'Link não encontrado', 'PUBLIC_LINK_NOT_FOUND'),
        );
      }
      return toLinkJson(link);
    },
  );
}
