import { and, asc, count, eq, sql } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import {
  effectivePermissions,
  normalizePermissions,
  type Permission,
  type PermissionMap,
  type StoreRole,
} from '../auth/permissions.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';
import { notify } from '../notifications/service.js';

const { users, storeMembers, notifications } = schema;

/** Quanto tempo a mesma pessoa espera para pedir a mesma permissão de novo. */
export const PERMISSION_REQUEST_COOLDOWN_HOURS = 24;

export type PermissionRequestResult =
  | { ok: true; permission: Permission; requestedAt: Date }
  | { ok: false; reason: 'ALREADY_GRANTED' | 'TOO_SOON' };

export interface TeamMember {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  role: StoreRole;
  permissions: PermissionMap;
  createdAt: Date;
}

export type UpdatePermissionsResult =
  { ok: true; member: TeamMember } | { ok: false; reason: 'NOT_FOUND' | 'OWNER_PERMISSIONS_FIXED' };

export type RemoveMemberResult = { ok: true } | { ok: false; reason: 'NOT_FOUND' | 'LAST_OWNER' };

interface Context {
  storeId: string;
  userId: string;
}

/** Equipe da loja. Tudo roda com o contexto da loja (RLS) e é registrado no log de atividades. */
export class TeamService {
  constructor(private readonly db: Db) {}

  async list(
    context: Context,
    query: { limit: number; cursor?: string },
  ): Promise<Page<TeamMember> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';

    const rows = await withContext(this.db, context, (tx) =>
      tx
        .select({ member: storeMembers, email: users.email, name: users.name })
        .from(storeMembers)
        .innerJoin(users, eq(users.id, storeMembers.userId))
        .where(
          and(
            eq(storeMembers.storeId, context.storeId),
            position === null
              ? undefined
              : sql`(${storeMembers.createdAt}, ${storeMembers.id}) > (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(asc(storeMembers.createdAt), asc(storeMembers.id))
        .limit(query.limit + 1),
    );
    return toPage(
      rows.map(({ member, email, name }) => ({
        id: member.id,
        userId: member.userId,
        email,
        name,
        role: member.role,
        permissions: effectivePermissions(member.role, member.permissions),
        createdAt: member.createdAt,
      })),
      query.limit,
    );
  }

  /**
   * O funcionário pede uma permissão ao proprietário. Não concede nada: grava um aviso na central da
   * loja (só ids: quem pediu e qual permissão) e uma linha no log. O mesmo pedido da mesma pessoa só
   * se repete depois de `PERMISSION_REQUEST_COOLDOWN_HOURS`; a trava de transação impede que dois
   * pedidos simultâneos passem juntos.
   */
  async requestPermission(
    context: Context,
    current: PermissionMap,
    permission: Permission,
  ): Promise<PermissionRequestResult> {
    if (current[permission]) return { ok: false, reason: 'ALREADY_GRANTED' };
    return withContext(this.db, context, async (tx) => {
      const lockKey = `permission-request:${context.storeId}:${context.userId}:${permission}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      const [recent] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(
          and(
            eq(notifications.storeId, context.storeId),
            eq(notifications.kind, 'PERMISSION_REQUESTED'),
            sql`${notifications.data}->>'user_id' = ${context.userId}`,
            sql`${notifications.data}->>'permission' = ${permission}`,
            sql`${notifications.createdAt} > now() - make_interval(hours => ${PERMISSION_REQUEST_COOLDOWN_HOURS})`,
          ),
        )
        .limit(1);
      if (recent !== undefined) return { ok: false, reason: 'TOO_SOON' } as const;

      const [member] = await tx
        .select({ id: storeMembers.id })
        .from(storeMembers)
        .where(
          and(eq(storeMembers.storeId, context.storeId), eq(storeMembers.userId, context.userId)),
        )
        .limit(1);
      await notify(tx, context.storeId, 'PERMISSION_REQUESTED', {
        user_id: context.userId,
        permission,
      });
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'permission.requested',
        targetType: 'member',
        ...(member === undefined ? {} : { targetId: member.id }),
        details: { permission },
      });
      return { ok: true, permission, requestedAt: new Date() } as const;
    });
  }

  /** Ajusta as permissões de um funcionário. O proprietário tem tudo e não é ajustável. */
  async updatePermissions(
    context: Context,
    memberId: string,
    input: unknown,
  ): Promise<UpdatePermissionsResult> {
    return withContext(this.db, context, async (tx) => {
      const [row] = await tx
        .select({ member: storeMembers, email: users.email, name: users.name })
        .from(storeMembers)
        .innerJoin(users, eq(users.id, storeMembers.userId))
        .where(and(eq(storeMembers.id, memberId), eq(storeMembers.storeId, context.storeId)))
        .for('update', { of: storeMembers })
        .limit(1);
      if (row === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (row.member.role === 'OWNER')
        return { ok: false, reason: 'OWNER_PERMISSIONS_FIXED' } as const;

      const change = normalizePermissions(input);
      const merged = { ...normalizePermissions(row.member.permissions), ...change };
      await tx
        .update(storeMembers)
        .set({ permissions: merged })
        .where(eq(storeMembers.id, memberId));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'member.permissions_updated',
        targetType: 'member',
        targetId: memberId,
        details: { changed: Object.keys(change) },
      });
      return {
        ok: true,
        member: {
          id: row.member.id,
          userId: row.member.userId,
          email: row.email,
          name: row.name,
          role: row.member.role,
          permissions: effectivePermissions(row.member.role, merged),
          createdAt: row.member.createdAt,
        },
      } as const;
    });
  }

  /** Remove um membro. Nunca deixa a loja sem proprietário, nem sob concorrência. */
  async remove(context: Context, memberId: string): Promise<RemoveMemberResult> {
    return withContext(this.db, context, async (tx) => {
      // Trava os proprietários antes de contar: duas remoções simultâneas se enfileiram.
      const owners = await tx
        .select({ id: storeMembers.id })
        .from(storeMembers)
        .where(and(eq(storeMembers.storeId, context.storeId), eq(storeMembers.role, 'OWNER')))
        .for('update');

      const [target] = await tx
        .select()
        .from(storeMembers)
        .where(and(eq(storeMembers.id, memberId), eq(storeMembers.storeId, context.storeId)))
        .limit(1);
      if (target === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (target.role === 'OWNER' && owners.length <= 1) {
        return { ok: false, reason: 'LAST_OWNER' } as const;
      }

      await tx.delete(storeMembers).where(eq(storeMembers.id, memberId));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'member.removed',
        targetType: 'member',
        targetId: memberId,
        details: { role: target.role },
      });
      return { ok: true } as const;
    });
  }

  /** Quantos proprietários a loja tem (usado nos testes de corrida). */
  async countOwners(context: Context): Promise<number> {
    return withContext(this.db, context, async (tx) => {
      const [row] = await tx
        .select({ total: count() })
        .from(storeMembers)
        .where(and(eq(storeMembers.storeId, context.storeId), eq(storeMembers.role, 'OWNER')));
      return row?.total ?? 0;
    });
  }
}
