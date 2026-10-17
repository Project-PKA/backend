import { and, eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { AuthConfig } from '../config/env.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { buildProblem, sendProblem } from '../http/problem.js';
import { verifyAccessToken } from './jwt.js';
import { effectivePermissions, type Permission, type TenantContext } from './permissions.js';

const { users, storeMembers } = schema;

export interface AuthContext {
  userId: string;
  email: string;
  isPlatformAdmin: boolean;
  canCreateStores: boolean;
  storeLimit: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    tenant: TenantContext | null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/;

type Hook = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function unauthenticated(reply: FastifyReply): FastifyReply {
  void reply.header('WWW-Authenticate', 'Bearer');
  return sendProblem(reply, buildProblem(401, 'Autenticação necessária', 'UNAUTHENTICATED'));
}

function forbidden(reply: FastifyReply, code = 'FORBIDDEN'): FastifyReply {
  return sendProblem(reply, buildProblem(403, 'Acesso negado', code));
}

export interface AuthHooks {
  /** Exige JWT válido e conta ativa. Define `request.auth`. */
  authenticate: Hook;
  /** Exige `x-store-id` de uma loja da qual a pessoa participa. Define `request.tenant`. */
  requireStore: Hook;
  /** Exige uma permissão da loja. Roda depois de `requireStore`. */
  requirePermission: (permission: Permission) => Hook;
  /** Exige o papel de proprietário da loja. Roda depois de `requireStore`. */
  requireOwner: Hook;
  /** Exige administrador da plataforma. Roda depois de `authenticate`. */
  requirePlatformAdmin: Hook;
}

export function createAuthHooks(deps: { db: Db; config: AuthConfig }): AuthHooks {
  const authenticate: Hook = async (request, reply) => {
    const match = BEARER.exec(request.headers.authorization ?? '');
    if (match?.[1] === undefined) return unauthenticated(reply);

    const userId = await verifyAccessToken(deps.config, match[1]);
    if (userId === null || !UUID.test(userId)) return unauthenticated(reply);

    // Confere no banco a cada requisição: conta suspensa perde o acesso na hora,
    // sem esperar o JWT vencer.
    const [user] = await deps.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user?.status !== 'ACTIVE') return unauthenticated(reply);

    request.auth = {
      userId: user.id,
      email: user.email,
      isPlatformAdmin: user.isPlatformAdmin,
      canCreateStores: user.canCreateStores,
      storeLimit: user.storeLimit,
    };
    return undefined;
  };

  const requireStore: Hook = async (request, reply) => {
    const auth = request.auth;
    if (auth === null) return unauthenticated(reply);

    const header = request.headers['x-store-id'];
    const storeId = typeof header === 'string' ? header : '';
    // Header ausente, malformado ou de loja alheia: a mesma resposta.
    if (!UUID.test(storeId)) return forbidden(reply);

    const membership = await withContext(deps.db, { userId: auth.userId, storeId }, async (tx) => {
      const [row] = await tx
        .select()
        .from(storeMembers)
        .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.userId, auth.userId)))
        .limit(1);
      return row ?? null;
    });
    if (membership === null) return forbidden(reply);

    request.tenant = {
      storeId,
      role: membership.role,
      permissions: effectivePermissions(membership.role, membership.permissions),
    };
    return undefined;
  };

  const requirePermission =
    (permission: Permission): Hook =>
    (request, reply) => {
      const tenant = request.tenant;
      if (tenant === null) return Promise.resolve(forbidden(reply));
      if (!tenant.permissions[permission]) {
        return Promise.resolve(forbidden(reply, 'MISSING_PERMISSION'));
      }
      return Promise.resolve(undefined);
    };

  const requireOwner: Hook = (request, reply) => {
    if (request.tenant?.role !== 'OWNER') {
      return Promise.resolve(forbidden(reply, 'OWNER_REQUIRED'));
    }
    return Promise.resolve(undefined);
  };

  const requirePlatformAdmin: Hook = (request, reply) => {
    if (request.auth?.isPlatformAdmin !== true) return Promise.resolve(forbidden(reply));
    return Promise.resolve(undefined);
  };

  return { authenticate, requireStore, requirePermission, requireOwner, requirePlatformAdmin };
}
