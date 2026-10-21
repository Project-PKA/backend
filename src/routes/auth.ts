import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { InvitationService } from '../auth/invitations.js';
import type { AuthService, Session } from '../auth/service.js';
import type { Env } from '../config/env.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';

export const REFRESH_COOKIE = 'refresh_token';
export const COOKIE_PATH = '/v1/auth';

export interface AuthRouteDeps {
  env: Env;
  auth: AuthService;
  invitations: InvitationService;
}

const emailSchema = { type: 'string', format: 'email', maxLength: 254 } as const;

const sessionResponse = {
  type: 'object',
  required: ['access_token', 'token_type', 'expires_in', 'user'],
  properties: {
    access_token: { type: 'string' },
    token_type: { type: 'string', enum: ['Bearer'] },
    expires_in: { type: 'integer', description: 'Segundos até o access token vencer' },
    user: {
      type: 'object',
      required: ['id', 'email', 'name'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        email: { type: 'string' },
        name: { type: 'string', nullable: true },
      },
    },
  },
} as const;

function meta(request: FastifyRequest) {
  const agent = request.headers['user-agent'];
  return { ip: request.ip, userAgent: typeof agent === 'string' ? agent : null };
}

export function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  const { env, auth, invitations } = deps;

  const setRefreshCookie = (reply: FastifyReply, session: Session): void => {
    void reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: env.secureCookies,
      sameSite: 'strict',
      path: COOKIE_PATH,
      expires: session.refreshExpiresAt,
    });
  };
  const clearRefreshCookie = (reply: FastifyReply): void => {
    void reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
  };
  const toBody = (session: Session) => ({
    access_token: session.accessToken,
    token_type: 'Bearer' as const,
    expires_in: session.expiresIn,
    user: session.user,
  });
  const invalidCode = (reply: FastifyReply) =>
    sendProblem(reply, buildProblem(401, 'Código inválido ou expirado', 'INVALID_CODE'));
  const invalidInvitation = (reply: FastifyReply) =>
    sendProblem(reply, buildProblem(404, 'Convite inválido ou expirado', 'INVITATION_INVALID'));

  app.post(
    '/v1/auth/otp/request',
    {
      config: { rateLimit: { max: env.rateLimit.otpRequest, timeWindow: '1 minute' } },
      schema: {
        operationId: 'requestOtp',
        tags: ['auth'],
        summary: 'Pede um código de login por e-mail',
        description:
          'Resposta sempre igual, exista ou não conta ativa para o e-mail. O acesso é somente por convite.',
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: { email: emailSchema },
        },
        response: {
          202: {
            type: 'object',
            required: ['status'],
            properties: { status: { type: 'string', enum: ['accepted'] } },
          },
          429: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { email } = request.body as { email: string };
      await auth.requestOtp(email);
      return reply.status(202).send({ status: 'accepted' });
    },
  );

  app.post(
    '/v1/auth/otp/verify',
    {
      config: { rateLimit: { max: env.rateLimit.otpVerify, timeWindow: '1 minute' } },
      schema: {
        operationId: 'verifyOtp',
        tags: ['auth'],
        summary: 'Troca o código por uma sessão',
        description: 'Devolve o access token e grava o refresh token em cookie httpOnly.',
        body: {
          type: 'object',
          required: ['email', 'code'],
          additionalProperties: false,
          properties: { email: emailSchema, code: { type: 'string', pattern: '^[0-9]{6}$' } },
        },
        response: { 200: sessionResponse, 401: problemSchema, 429: problemSchema },
      },
    },
    async (request, reply) => {
      const { email, code } = request.body as { email: string; code: string };
      const session = await auth.verifyOtp(email, code, meta(request));
      if (session === null) return invalidCode(reply);
      setRefreshCookie(reply, session);
      return toBody(session);
    },
  );

  app.post(
    '/v1/auth/refresh',
    {
      config: { rateLimit: { max: env.rateLimit.otpVerify, timeWindow: '1 minute' } },
      schema: {
        operationId: 'refreshSession',
        tags: ['auth'],
        summary: 'Renova a sessão com o refresh token do cookie',
        response: { 200: sessionResponse, 401: problemSchema, 429: problemSchema },
      },
    },
    async (request, reply) => {
      const raw = request.cookies[REFRESH_COOKIE];
      if (raw === undefined || raw === '') {
        clearRefreshCookie(reply);
        return sendProblem(reply, buildProblem(401, 'Sessão inválida', 'INVALID_REFRESH'));
      }
      const session = await auth.refresh(raw, meta(request));
      if (session === null) {
        clearRefreshCookie(reply);
        return sendProblem(reply, buildProblem(401, 'Sessão inválida', 'INVALID_REFRESH'));
      }
      setRefreshCookie(reply, session);
      return toBody(session);
    },
  );

  app.post(
    '/v1/auth/logout',
    {
      schema: {
        operationId: 'logout',
        tags: ['auth'],
        summary: 'Encerra a sessão atual',
        response: { 204: { type: 'null' } },
      },
    },
    async (request, reply) => {
      const raw = request.cookies[REFRESH_COOKIE];
      if (raw !== undefined && raw !== '') await auth.logout(raw);
      clearRefreshCookie(reply);
      return reply.status(204).send();
    },
  );

  const tokenBody = {
    type: 'object',
    required: ['token'],
    additionalProperties: false,
    properties: { token: { type: 'string', minLength: 20, maxLength: 200 } },
  } as const;

  app.post(
    '/v1/auth/invitations/preview',
    {
      config: { rateLimit: { max: env.rateLimit.otpVerify, timeWindow: '1 minute' } },
      schema: {
        operationId: 'previewInvitation',
        tags: ['auth'],
        summary: 'Mostra loja, papel e permissões de um convite, sem aceitá-lo',
        body: tokenBody,
        response: {
          200: {
            type: 'object',
            required: ['email', 'store_name', 'role', 'permissions', 'expires_at'],
            properties: {
              email: { type: 'string' },
              store_name: { type: 'string', nullable: true },
              role: { type: 'string', enum: ['OWNER', 'STAFF'], nullable: true },
              permissions: {
                type: 'object',
                nullable: true,
                additionalProperties: { type: 'boolean' },
              },
              expires_at: { type: 'string', format: 'date-time' },
            },
          },
          404: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body as { token: string };
      const preview = await invitations.preview(token);
      if (preview === null) return invalidInvitation(reply);
      return {
        email: preview.email,
        store_name: preview.storeName,
        role: preview.role,
        permissions: preview.permissions,
        expires_at: preview.expiresAt.toISOString(),
      };
    },
  );

  app.post(
    '/v1/auth/invitations/accept',
    {
      config: { rateLimit: { max: env.rateLimit.otpVerify, timeWindow: '1 minute' } },
      schema: {
        operationId: 'acceptInvitation',
        tags: ['auth'],
        summary: 'Aceita o convite. Depois, o login é por código no e-mail',
        body: tokenBody,
        response: {
          200: {
            type: 'object',
            required: ['status'],
            properties: { status: { type: 'string', enum: ['accepted'] } },
          },
          404: problemSchema,
          429: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { token } = request.body as { token: string };
      const accepted = await invitations.accept(token);
      if (accepted === null) return invalidInvitation(reply);
      return { status: 'accepted' as const };
    },
  );
}
