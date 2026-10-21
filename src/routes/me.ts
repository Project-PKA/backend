import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import type { AuthService } from '../auth/service.js';
import {
  EMPTY_PERSONAL,
  type PersonalData,
  type PersonalAddress,
  type PersonalFailure,
  type ProfileService,
} from '../profile/service.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import { COOKIE_PATH, REFRESH_COOKIE } from './auth.js';

const { stores, storeMembers } = schema;

export interface MeRouteDeps {
  db: Db;
  auth: AuthService;
  hooks: AuthHooks;
  profile: ProfileService;
}

const nullableText = (maxLength: number) =>
  ({ type: 'string', maxLength, nullable: true }) as const;

const addressInput = {
  type: 'object',
  additionalProperties: false,
  description: 'Mescla com o endereço atual: só os campos enviados mudam e `null` limpa o campo.',
  properties: {
    zip: nullableText(9),
    street: nullableText(120),
    number: nullableText(20),
    comp: nullableText(60),
    neighborhood: nullableText(80),
    city: nullableText(80),
    state: { type: 'string', pattern: '^[A-Za-z]{2}$', nullable: true },
  },
} as const;

const addressOutput = {
  type: 'object',
  required: ['zip', 'street', 'number', 'comp', 'neighborhood', 'city', 'state'],
  properties: {
    zip: { type: 'string', nullable: true },
    street: { type: 'string', nullable: true },
    number: { type: 'string', nullable: true },
    comp: { type: 'string', nullable: true },
    neighborhood: { type: 'string', nullable: true },
    city: { type: 'string', nullable: true },
    state: { type: 'string', nullable: true },
  },
} as const;

const meResponse = {
  type: 'object',
  required: [
    'id',
    'email',
    'name',
    'is_platform_admin',
    'can_create_stores',
    'store_limit',
    'phone',
    'birth_date',
    'cpf_masked',
    'address',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    email: { type: 'string' },
    name: { type: 'string', nullable: true },
    is_platform_admin: { type: 'boolean' },
    can_create_stores: { type: 'boolean' },
    store_limit: { type: 'integer' },
    phone: { type: 'string', nullable: true, description: 'Só dígitos, com código do país' },
    birth_date: { type: 'string', format: 'date', nullable: true },
    cpf_masked: {
      type: 'string',
      nullable: true,
      description: 'Só os dois últimos dígitos; o CPF inteiro nunca sai da API',
    },
    address: addressOutput,
  },
} as const;

const PERSONAL_FAILURES: Record<PersonalFailure, [number, string]> = {
  PHONE_INVALID: [422, 'Telefone inválido: informe com DDD (e código do país, se for de fora)'],
  CPF_INVALID: [422, 'CPF inválido'],
  CEP_INVALID: [422, 'CEP inválido'],
  BIRTH_DATE_INVALID: [422, 'Data de nascimento inválida'],
};

const toMeJson = (
  current: {
    userId: string;
    email: string;
    isPlatformAdmin: boolean;
    canCreateStores: boolean;
    storeLimit: number;
  },
  data: PersonalData,
) => ({
  id: current.userId,
  email: current.email,
  is_platform_admin: current.isPlatformAdmin,
  can_create_stores: current.canCreateStores,
  store_limit: current.storeLimit,
  name: data.name,
  phone: data.phone,
  birth_date: data.birthDate,
  cpf_masked: data.cpfMasked,
  address: data.address,
});

const security = [{ bearerAuth: [] }];

export function meRoutes(app: FastifyInstance, deps: MeRouteDeps): void {
  const { db, auth, hooks, profile } = deps;
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
        response: { 200: meResponse, 401: problemSchema },
      },
    },
    async (request) => {
      const current = request.auth;
      if (current === null) throw new Error('authenticate não definiu request.auth');
      const personal = await profile.getPersonal(current.userId);
      return toMeJson(current, personal ?? EMPTY_PERSONAL);
    },
  );

  app.patch(
    '/v1/me',
    {
      ...onlyAuthenticated,
      schema: {
        operationId: 'updateMe',
        tags: ['me'],
        summary: 'Edita os dados pessoais de quem está logado',
        description:
          'Só os campos enviados mudam; `null` limpa. O CPF é validado e guardado cifrado (ADR 0019) e nunca volta inteiro. ' +
          'O e-mail e as permissões não mudam por aqui.',
        security,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' },
            phone: { type: 'string', maxLength: 20, nullable: true },
            birth_date: { type: 'string', format: 'date', nullable: true },
            cpf: {
              type: 'string',
              maxLength: 14,
              nullable: true,
              description: 'Validado; nunca devolvido inteiro',
            },
            address: addressInput,
          },
        },
        response: { 200: meResponse, 400: problemSchema, 401: problemSchema, 422: problemSchema },
      },
    },
    async (request, reply) => {
      const current = request.auth;
      if (current === null) throw new Error('authenticate não definiu request.auth');
      const body = request.body as {
        name?: string;
        phone?: string | null;
        birth_date?: string | null;
        cpf?: string | null;
        address?: Partial<PersonalAddress>;
      };
      const result = await profile.updatePersonal(current.userId, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.phone === undefined ? {} : { phone: body.phone }),
        ...(body.birth_date === undefined ? {} : { birthDate: body.birth_date }),
        ...(body.cpf === undefined ? {} : { cpf: body.cpf }),
        ...(body.address === undefined ? {} : { address: body.address }),
      });
      if (!result.ok) {
        if (result.reason === 'NOT_FOUND') throw new Error('usuário autenticado não encontrado');
        const [status, detail] = PERSONAL_FAILURES[result.reason];
        return sendProblem(reply, buildProblem(status, detail, `PROFILE_${result.reason}`));
      }
      return toMeJson(current, result.data);
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
    '/v1/me/sessions',
    {
      ...onlyAuthenticated,
      schema: {
        operationId: 'revokeAllMySessions',
        tags: ['me'],
        summary: 'Encerra todas as sessões ("Sair de todos os aparelhos")',
        description:
          'Por padrão encerra também a sessão atual (o cookie de renovação é apagado; o access token em uso vale só até expirar, no máximo 15 minutos). ' +
          'Com `keep_current=true` a sessão deste aparelho continua (precisa do cookie de renovação para saber qual é).',
        security,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { keep_current: { type: 'boolean', default: false } },
        },
        response: { 204: { type: 'null' }, 401: problemSchema },
      },
    },
    async (request, reply) => {
      const current = request.auth;
      if (current === null) throw new Error('authenticate não definiu request.auth');
      const keep = (request.query as { keep_current?: boolean }).keep_current === true;
      const raw = request.cookies[REFRESH_COOKIE] ?? null;
      await auth.revokeAllSessionsOf(current.userId, keep ? raw : null);
      if (!keep) void reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
      return reply.status(204).send();
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
