import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';

import type { AuthService } from '../auth/service.js';
import { normalizeEmail } from '../auth/service.js';
import type { InvitationService } from '../auth/invitations.js';
import { withContext, type Db, type Tx } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';

const {
  users,
  stores,
  storeMembers,
  invitations,
  accessRequests,
  adminActivityLog,
  planChangeRequests,
} = schema;

/** Quem age é sempre o administrador; o contexto dele é o que o RLS reconhece. */
interface Admin {
  userId: string;
}

const adminContext = (admin: Admin) => ({ userId: admin.userId, isPlatformAdmin: true });

type UserStatus = (typeof schema.userStatus.enumValues)[number];

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  status: UserStatus;
  canCreateStores: boolean;
  storeLimit: number;
  isPlatformAdmin: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  storesCount: number;
}

/** Usuário como a lista e o detalhe o mostram: com o convite que ainda espera resposta. */
export interface AdminUserView extends AdminUser {
  /**
   * Convite pendente de quem ainda não aceitou (`INVITED`), para "Reenviar convite". Prefere o convite
   * só de conta; senão o mais recente. `null` se a pessoa já aceitou ou não há convite pendente.
   */
  pendingInvitationId: string | null;
}

export interface AdminUserDetail extends AdminUserView {
  stores: { id: string; name: string; role: 'OWNER' | 'STAFF' }[];
}

export interface AdminStore {
  id: string;
  name: string;
  city: string | null;
  plan: string;
  memberLimit: number;
  cardLimit: number | null;
  membersCount: number;
  whatsappStatus: 'ONLINE' | 'OFFLINE' | 'QR_READY';
  owner: { id: string; email: string; name: string | null } | null;
  createdAt: Date;
}

export type InvitationKind = 'ACCOUNT' | 'OWNER' | 'STAFF';

export interface PlanRequestView {
  id: string;
  createdAt: Date;
  store: { id: string; name: string; currentPlan: string };
  requestedPlan: string | null;
  message: string | null;
  status: (typeof schema.planRequestStatus.enumValues)[number];
  decidedAt: Date | null;
}

export interface AdminInvitation {
  id: string;
  email: string;
  kind: InvitationKind;
  store: { id: string; name: string } | null;
  state: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  expiresAt: Date;
  createdAt: Date;
}

export interface AccessRequestView {
  id: string;
  name: string;
  email: string;
  whatsapp: string | null;
  storeName: string;
  message: string | null;
  status: (typeof schema.accessRequestStatus.enumValues)[number];
  decidedAt: Date | null;
  convertedStoreId: string | null;
  createdAt: Date;
}

export type AdminFailure =
  | 'NOT_FOUND'
  | 'EMAIL_TAKEN'
  | 'INVALID_LIMIT'
  | 'SELF_ACTION'
  | 'ADMIN_PROTECTED'
  | 'NOT_SUSPENDED'
  | 'OWNER_NOT_FOUND'
  | 'OWNER_NOT_ACTIVE'
  | 'OWNER_SUSPENDED'
  | 'REQUEST_NOT_PENDING'
  | 'ALREADY_OWNER'
  | 'NOT_PENDING'
  | 'TOO_SOON'
  | 'LIMIT_BELOW_USAGE';

export type AdminResult<T> = { ok: true; value: T } | { ok: false; reason: AdminFailure };

export interface CreateStoreInput {
  name: string;
  city?: string | null;
  plan?: string;
  memberLimit?: number;
  cardLimit?: number | null;
  owner: { userId: string } | { email: string };
  accessRequestId?: string;
}

export interface Overview {
  activeUsers: number;
  stores: number;
  pendingInvitations: number;
  newAccessRequests: number;
  pendingPlanRequests: number;
  disconnectedStores: {
    id: string;
    name: string;
    city: string | null;
    whatsappStatus: 'OFFLINE' | 'QR_READY';
  }[];
}

const ok = <T>(value: T): AdminResult<T> => ({ ok: true, value });
const fail = (reason: AdminFailure): AdminResult<never> => ({ ok: false, reason });

function toUser(row: typeof users.$inferSelect, storesCount: number): AdminUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    canCreateStores: row.canCreateStores,
    storeLimit: row.storeLimit,
    isPlatformAdmin: row.isPlatformAdmin,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
    storesCount,
  };
}

/** Subconsulta do convite pendente de um usuário `INVITED` (a tabela `users` da consulta externa). */
const pendingInvitationOf = () =>
  sql<string | null>`(
    SELECT i.id FROM invitations i
     WHERE users.status = 'INVITED' AND i.email = users.email AND i.status = 'PENDING'
     ORDER BY (i.store_id IS NULL) DESC, i.created_at DESC, i.id DESC
     LIMIT 1)`;

/**
 * Administração da plataforma (ADR 0012). Só lê e altera o que é da plataforma (contas, lojas e
 * convites). O banco não deixa o administrador ler estoque, clientes, leilões, lances nem acertos:
 * as consultas daqui nunca tocam essas tabelas.
 */
export class AdminService {
  constructor(
    private readonly db: Db,
    private readonly auth: AuthService,
    private readonly invitationService: InvitationService,
    private readonly resendSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async log(
    tx: Tx,
    admin: Admin,
    action: string,
    target?: { type: string; id: string },
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await tx.insert(adminActivityLog).values({
      actorUserId: admin.userId,
      action,
      targetType: target?.type ?? null,
      targetId: target?.id ?? null,
      details,
    });
  }

  // --- Usuários --------------------------------------------------------------------------------

  async listUsers(
    admin: Admin,
    query: {
      limit: number;
      cursor?: string;
      q?: string;
      status?: UserStatus;
      canCreateStores?: boolean;
    },
  ): Promise<Page<AdminUserView> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const text = query.q?.trim().replaceAll(/[\\%_]/g, '\\$&') ?? '';

    const rows = await withContext(this.db, adminContext(admin), async (tx) => {
      const found = await tx
        .select({
          user: users,
          storesCount: sql<string>`(SELECT count(*) FROM store_members m WHERE m.user_id = users.id)`,
          pendingInvitationId: pendingInvitationOf(),
        })
        .from(users)
        .where(
          and(
            query.status === undefined ? undefined : eq(users.status, query.status),
            query.canCreateStores === undefined
              ? undefined
              : eq(users.canCreateStores, query.canCreateStores),
            text === ''
              ? undefined
              : sql`(${users.email} ILIKE ${'%' + text + '%'} ESCAPE '\\' OR ${users.name} ILIKE ${'%' + text + '%'} ESCAPE '\\')`,
            position === null
              ? undefined
              : sql`(${users.createdAt}, ${users.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(query.limit + 1);
      return found.map((r) => ({
        ...toUser(r.user, Number(r.storesCount)),
        pendingInvitationId: r.pendingInvitationId,
      }));
    });
    return toPage(rows, query.limit);
  }

  async getUser(admin: Admin, id: string): Promise<AdminUserDetail | null> {
    return withContext(this.db, adminContext(admin), async (tx) => {
      const [found] = await tx
        .select({ user: users, pendingInvitationId: pendingInvitationOf() })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);
      if (found === undefined) return null;
      const { user, pendingInvitationId } = found;
      const memberships = await tx
        .select({ id: stores.id, name: stores.name, role: storeMembers.role })
        .from(storeMembers)
        .innerJoin(stores, eq(stores.id, storeMembers.storeId))
        .where(eq(storeMembers.userId, id))
        .orderBy(stores.name);
      return { ...toUser(user, memberships.length), pendingInvitationId, stores: memberships };
    });
  }

  private validLimit(canCreateStores: boolean, storeLimit: number): boolean {
    return Number.isInteger(storeLimit) && storeLimit >= 0 && (canCreateStores || storeLimit === 0);
  }

  /** Cadastra a conta e envia o convite (só de conta, sem loja). */
  async createUser(
    admin: Admin,
    input: { email: string; name?: string; canCreateStores: boolean; storeLimit: number },
  ): Promise<AdminResult<AdminUser>> {
    if (!this.validLimit(input.canCreateStores, input.storeLimit)) return fail('INVALID_LIMIT');
    const email = normalizeEmail(input.email);
    const created = await withContext(this.db, adminContext(admin), async (tx) => {
      const [existing] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email));
      if (existing !== undefined) return null;
      const [row] = await tx
        .insert(users)
        .values({
          email,
          name: input.name?.trim() ?? null,
          status: 'INVITED',
          canCreateStores: input.canCreateStores,
          storeLimit: input.storeLimit,
        })
        .returning();
      if (row === undefined) throw new Error('o usuário não foi criado');
      await this.log(
        tx,
        admin,
        'user.created',
        { type: 'user', id: row.id },
        {
          can_create_stores: input.canCreateStores,
          store_limit: input.storeLimit,
        },
      );
      return row;
    });
    if (created === null) return fail('EMAIL_TAKEN');
    await this.invitationService.create({ email, invitedBy: admin.userId });
    return ok(toUser(created, 0));
  }

  async setPermissions(
    admin: Admin,
    id: string,
    input: { canCreateStores?: boolean; storeLimit?: number },
  ): Promise<AdminResult<AdminUser>> {
    return withContext(this.db, adminContext(admin), async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (current === undefined) return fail('NOT_FOUND');
      const canCreateStores = input.canCreateStores ?? current.canCreateStores;
      const storeLimit = input.storeLimit ?? current.storeLimit;
      if (!this.validLimit(canCreateStores, storeLimit)) return fail('INVALID_LIMIT');

      const [updated] = await tx
        .update(users)
        .set({ canCreateStores, storeLimit })
        .where(eq(users.id, id))
        .returning();
      if (updated === undefined) throw new Error('o usuário não foi atualizado');
      await this.log(
        tx,
        admin,
        'user.permissions_updated',
        { type: 'user', id },
        {
          can_create_stores: canCreateStores,
          store_limit: storeLimit,
        },
      );
      const [count] = await tx
        .select({ n: sql<string>`count(*)` })
        .from(storeMembers)
        .where(eq(storeMembers.userId, id));
      return ok(toUser(updated, Number(count?.n ?? 0)));
    });
  }

  /** Suspende: impede o login e derruba as sessões, sem apagar nenhum dado. */
  async suspend(admin: Admin, id: string): Promise<AdminResult<AdminUser>> {
    if (id === admin.userId) return fail('SELF_ACTION');
    const result = await withContext(this.db, adminContext(admin), async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (current === undefined) return fail('NOT_FOUND');
      if (current.isPlatformAdmin) return fail('ADMIN_PROTECTED');
      const [updated] = await tx
        .update(users)
        .set({ status: 'SUSPENDED', otpHash: null, otpExpiresAt: null })
        .where(eq(users.id, id))
        .returning();
      if (updated === undefined) throw new Error('o usuário não foi suspenso');
      await this.log(tx, admin, 'user.suspended', { type: 'user', id });
      return ok(toUser(updated, 0));
    });
    if (result.ok) await this.auth.revokeAllSessions(id);
    return result;
  }

  /** Reativa: volta a `ACTIVE`, ou a `INVITED` se a pessoa nunca chegou a entrar. */
  async reactivate(admin: Admin, id: string): Promise<AdminResult<AdminUser>> {
    return withContext(this.db, adminContext(admin), async (tx) => {
      const [current] = await tx.select().from(users).where(eq(users.id, id)).for('update');
      if (current === undefined) return fail('NOT_FOUND');
      if (current.status !== 'SUSPENDED') return fail('NOT_SUSPENDED');
      const [updated] = await tx
        .update(users)
        .set({ status: current.lastLoginAt === null ? 'INVITED' : 'ACTIVE' })
        .where(eq(users.id, id))
        .returning();
      if (updated === undefined) throw new Error('o usuário não foi reativado');
      await this.log(tx, admin, 'user.reactivated', { type: 'user', id });
      return ok(toUser(updated, 0));
    });
  }

  // --- Lojas -----------------------------------------------------------------------------------

  private async storeRows(
    tx: Tx,
    where: ReturnType<typeof sql>,
    limit: number,
  ): Promise<AdminStore[]> {
    const result = await tx.execute<{
      id: string;
      name: string;
      city: string | null;
      plan: string;
      member_limit: number;
      card_limit: number | null;
      members: string;
      whatsapp_status: 'ONLINE' | 'OFFLINE' | 'QR_READY';
      created_at: Date;
      owner_id: string | null;
      owner_email: string | null;
      owner_name: string | null;
    }>(sql`
      SELECT s.id, s.name, s.city, s.plan, s.member_limit, s.card_limit, s.whatsapp_status, s.created_at,
             (SELECT count(*) FROM store_members m WHERE m.store_id = s.id) AS members,
             o.user_id AS owner_id, u.email AS owner_email, u.name AS owner_name
        FROM stores s
        LEFT JOIN LATERAL (
          SELECT m.user_id FROM store_members m
           WHERE m.store_id = s.id AND m.role = 'OWNER' ORDER BY m.created_at, m.id LIMIT 1) o ON true
        LEFT JOIN users u ON u.id = o.user_id
       WHERE ${where}
       ORDER BY s.created_at DESC, s.id DESC
       LIMIT ${limit}
    `);
    return result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      city: r.city,
      plan: r.plan,
      memberLimit: r.member_limit,
      cardLimit: r.card_limit,
      membersCount: Number(r.members),
      whatsappStatus: r.whatsapp_status,
      owner:
        r.owner_id === null
          ? null
          : { id: r.owner_id, email: r.owner_email ?? '', name: r.owner_name },
      createdAt: new Date(r.created_at),
    }));
  }

  async listStores(
    admin: Admin,
    query: { limit: number; cursor?: string; q?: string },
  ): Promise<Page<AdminStore> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const text = query.q?.trim().replaceAll(/[\\%_]/g, '\\$&') ?? '';
    const filters = [sql`true`];
    if (text !== '') {
      const like = '%' + text + '%';
      filters.push(sql`(s.name ILIKE ${like} ESCAPE '\\' OR s.city ILIKE ${like} ESCAPE '\\')`);
    }
    if (position !== null) {
      filters.push(
        sql`(s.created_at, s.id) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
      );
    }
    const rows = await withContext(this.db, adminContext(admin), (tx) =>
      this.storeRows(tx, sql.join(filters, sql` AND `), query.limit + 1),
    );
    return toPage(rows, query.limit);
  }

  /** Conta ativa vira proprietária na hora; e-mail novo (ou convidado) recebe o convite. */
  private async resolveOwner(
    tx: Tx,
    owner: CreateStoreInput['owner'],
  ): Promise<AdminResult<{ ownerId: string | null; inviteEmail: string | null }>> {
    if ('userId' in owner) {
      const [found] = await tx.select().from(users).where(eq(users.id, owner.userId));
      if (found === undefined) return fail('OWNER_NOT_FOUND');
      if (found.status !== 'ACTIVE') return fail('OWNER_NOT_ACTIVE');
      return ok({ ownerId: found.id, inviteEmail: null });
    }
    const email = normalizeEmail(owner.email);
    const [found] = await tx.select().from(users).where(eq(users.email, email));
    if (found?.status === 'SUSPENDED') return fail('OWNER_SUSPENDED');
    return found?.status === 'ACTIVE'
      ? ok({ ownerId: found.id, inviteEmail: null })
      : ok({ ownerId: null, inviteEmail: email });
  }

  private async checkRequest(tx: Tx, id: string): Promise<AdminResult<null>> {
    const [request] = await tx
      .select({ status: accessRequests.status })
      .from(accessRequests)
      .where(eq(accessRequests.id, id))
      .for('update');
    if (request === undefined) return fail('NOT_FOUND');
    return request.status === 'PENDING' ? ok(null) : fail('REQUEST_NOT_PENDING');
  }

  /**
   * Cria a loja e o vínculo de proprietário numa transação, com o contexto do administrador. O
   * proprietário é uma conta ativa (vira `OWNER` na hora) ou um e-mail novo (recebe o convite).
   * Converte a solicitação de acesso, se vier de uma.
   */
  async createStore(
    admin: Admin,
    input: CreateStoreInput,
  ): Promise<AdminResult<{ store: AdminStore; ownerState: 'MEMBER' | 'INVITED' }>> {
    const storeId = crypto.randomUUID();
    let inviteEmail: string | null = null;

    const created = await withContext(this.db, { ...adminContext(admin), storeId }, async (tx) => {
      const owner = await this.resolveOwner(tx, input.owner);
      if (!owner.ok) return owner;
      const ownerId = owner.value.ownerId;
      inviteEmail = owner.value.inviteEmail;
      if (input.accessRequestId !== undefined) {
        const checked = await this.checkRequest(tx, input.accessRequestId);
        if (!checked.ok) return checked;
      }

      await tx.insert(stores).values({
        id: storeId,
        name: input.name.trim(),
        city: input.city ?? null,
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        ...(input.memberLimit === undefined ? {} : { memberLimit: input.memberLimit }),
        ...(input.cardLimit === undefined ? {} : { cardLimit: input.cardLimit }),
      });
      if (ownerId !== null) {
        await tx
          .insert(storeMembers)
          .values({ storeId, userId: ownerId, role: 'OWNER', permissions: {} });
      }
      if (input.accessRequestId !== undefined) {
        await tx
          .update(accessRequests)
          .set({
            status: 'CONVERTED',
            decidedBy: admin.userId,
            decidedAt: this.now(),
            convertedStoreId: storeId,
          })
          .where(eq(accessRequests.id, input.accessRequestId));
      }
      await tx.insert(schema.activityLog).values({
        storeId,
        actorUserId: admin.userId,
        action: 'store.created',
        targetType: 'store',
        targetId: storeId,
        details: { by_platform_admin: true },
      });
      await this.log(
        tx,
        admin,
        'store.created',
        { type: 'store', id: storeId },
        {
          access_request_id: input.accessRequestId ?? null,
          owner: ownerId === null ? 'INVITED' : 'MEMBER',
        },
      );
      const [row] = await this.storeRows(tx, sql`s.id = ${storeId}::uuid`, 1);
      if (row === undefined) throw new Error('a loja criada não foi encontrada');
      return ok(row);
    });
    if (!created.ok) return created;

    if (inviteEmail !== null) {
      const invited = await this.invitationService.create({
        email: inviteEmail,
        storeId,
        role: 'OWNER',
        invitedBy: admin.userId,
      });
      if (!invited.ok) return fail('OWNER_SUSPENDED');
    }
    return ok({ store: created.value, ownerState: inviteEmail === null ? 'MEMBER' : 'INVITED' });
  }

  /**
   * Passa a propriedade: a pessoa nova vira proprietária e os proprietários atuais viram
   * funcionários, na mesma transação e com os proprietários travados (como a remoção de membro):
   * a loja nunca fica sem proprietário, nem sob concorrência.
   */
  async transferOwnership(
    admin: Admin,
    storeId: string,
    newOwnerId: string,
  ): Promise<AdminResult<AdminStore>> {
    return withContext(this.db, { ...adminContext(admin), storeId }, async (tx) => {
      const [store] = await tx
        .select({ id: stores.id })
        .from(stores)
        .where(eq(stores.id, storeId))
        .for('update');
      if (store === undefined) return fail('NOT_FOUND');
      const owners = await tx
        .select({ id: storeMembers.id, userId: storeMembers.userId })
        .from(storeMembers)
        .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.role, 'OWNER')))
        .for('update');

      const [user] = await tx.select().from(users).where(eq(users.id, newOwnerId));
      if (user === undefined) return fail('OWNER_NOT_FOUND');
      if (user.status !== 'ACTIVE') return fail('OWNER_NOT_ACTIVE');
      if (owners.some((o) => o.userId === newOwnerId)) return fail('ALREADY_OWNER');

      // Primeiro entra o novo, depois saem os antigos: nunca zero proprietários.
      const [member] = await tx
        .select({ id: storeMembers.id })
        .from(storeMembers)
        .where(and(eq(storeMembers.storeId, storeId), eq(storeMembers.userId, newOwnerId)))
        .for('update');
      if (member === undefined) {
        await tx
          .insert(storeMembers)
          .values({ storeId, userId: newOwnerId, role: 'OWNER', permissions: {} });
      } else {
        await tx.update(storeMembers).set({ role: 'OWNER' }).where(eq(storeMembers.id, member.id));
      }
      if (owners.length > 0) {
        await tx
          .update(storeMembers)
          .set({ role: 'STAFF', permissions: {} })
          .where(
            inArray(
              storeMembers.id,
              owners.map((o) => o.id),
            ),
          );
      }
      await tx.insert(schema.activityLog).values({
        storeId,
        actorUserId: admin.userId,
        action: 'ownership.transferred',
        targetType: 'store',
        targetId: storeId,
        details: { by_platform_admin: true, to: newOwnerId, from: owners.map((o) => o.userId) },
      });
      await this.log(
        tx,
        admin,
        'store.ownership_transferred',
        { type: 'store', id: storeId },
        {
          to: newOwnerId,
          from: owners.map((o) => o.userId),
        },
      );
      const [row] = await this.storeRows(tx, sql`s.id = ${storeId}::uuid`, 1);
      if (row === undefined) throw new Error('a loja não foi encontrada');
      return ok(row);
    });
  }

  // --- Plano --------------------------------------------------------------------------------

  /** Muda o plano e os limites da loja (não há autoatendimento). Sem `cardLimit` o valor não muda; `null` = ilimitado. */
  async setStorePlan(
    admin: Admin,
    storeId: string,
    input: { plan?: string; memberLimit?: number; cardLimit?: number | null },
  ): Promise<AdminResult<AdminStore>> {
    return withContext(this.db, { ...adminContext(admin), storeId }, async (tx) =>
      this.applyPlan(tx, admin, storeId, input),
    );
  }

  private async applyPlan(
    tx: Tx,
    admin: Admin,
    storeId: string,
    input: { plan?: string; memberLimit?: number; cardLimit?: number | null },
  ): Promise<AdminResult<AdminStore>> {
    const [store] = await tx
      .select({ id: stores.id })
      .from(stores)
      .where(eq(stores.id, storeId))
      .for('update');
    if (store === undefined) return fail('NOT_FOUND');
    if (input.memberLimit !== undefined) {
      const [members] = await tx
        .select({ n: sql<string>`count(*)` })
        .from(storeMembers)
        .where(eq(storeMembers.storeId, storeId));
      if (input.memberLimit < Number(members?.n ?? 0)) return fail('LIMIT_BELOW_USAGE');
    }
    await tx
      .update(stores)
      .set({
        ...(input.plan === undefined ? {} : { plan: input.plan }),
        ...(input.memberLimit === undefined ? {} : { memberLimit: input.memberLimit }),
        ...(input.cardLimit === undefined ? {} : { cardLimit: input.cardLimit }),
      })
      .where(eq(stores.id, storeId));
    await tx.insert(schema.activityLog).values({
      storeId,
      actorUserId: admin.userId,
      action: 'plan.changed',
      targetType: 'store',
      targetId: storeId,
      details: { by_platform_admin: true, changed: Object.keys(input) },
    });
    await this.log(
      tx,
      admin,
      'store.plan_changed',
      { type: 'store', id: storeId },
      {
        plan: input.plan ?? null,
        member_limit: input.memberLimit ?? null,
        card_limit: input.cardLimit ?? null,
      },
    );
    const [row] = await this.storeRows(tx, sql`s.id = ${storeId}::uuid`, 1);
    if (row === undefined) throw new Error('a loja não foi encontrada');
    return ok(row);
  }

  async listPlanRequests(
    admin: Admin,
    query: { limit: number; cursor?: string; status?: PlanRequestView['status'] },
  ): Promise<Page<PlanRequestView> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const rows = await withContext(this.db, adminContext(admin), (tx) =>
      tx
        .select({ request: planChangeRequests, storeName: stores.name, currentPlan: stores.plan })
        .from(planChangeRequests)
        .innerJoin(stores, eq(stores.id, planChangeRequests.storeId))
        .where(
          and(
            query.status === undefined ? undefined : eq(planChangeRequests.status, query.status),
            position === null
              ? undefined
              : sql`(${planChangeRequests.createdAt}, ${planChangeRequests.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(planChangeRequests.createdAt), desc(planChangeRequests.id))
        .limit(query.limit + 1),
    );
    return toPage(
      rows.map(({ request, storeName, currentPlan }) => ({
        id: request.id,
        createdAt: request.createdAt,
        store: { id: request.storeId, name: storeName, currentPlan },
        requestedPlan: request.requestedPlan,
        message: request.message,
        status: request.status,
        decidedAt: request.decidedAt,
      })),
      query.limit,
    );
  }

  /** Decide o pedido: aplicar muda o plano da loja na mesma transação; recusar só encerra. */
  async resolvePlanRequest(
    admin: Admin,
    id: string,
    decision:
      | { kind: 'REFUSE' }
      | { kind: 'APPLY'; plan?: string; memberLimit?: number; cardLimit?: number | null },
  ): Promise<AdminResult<null>> {
    const [found] = await withContext(this.db, adminContext(admin), (tx) =>
      tx.select().from(planChangeRequests).where(eq(planChangeRequests.id, id)).limit(1),
    );
    if (found === undefined) return fail('NOT_FOUND');
    return withContext(this.db, { ...adminContext(admin), storeId: found.storeId }, async (tx) => {
      const [current] = await tx
        .select()
        .from(planChangeRequests)
        .where(eq(planChangeRequests.id, id))
        .for('update');
      if (current === undefined) return fail('NOT_FOUND');
      if (current.status !== 'PENDING') return fail('REQUEST_NOT_PENDING');

      if (decision.kind === 'APPLY') {
        const plan = decision.plan ?? current.requestedPlan ?? undefined;
        const applied = await this.applyPlan(tx, admin, current.storeId, {
          ...(plan === undefined ? {} : { plan }),
          ...(decision.memberLimit === undefined ? {} : { memberLimit: decision.memberLimit }),
          ...(decision.cardLimit === undefined ? {} : { cardLimit: decision.cardLimit }),
        });
        if (!applied.ok) return applied;
      }
      await tx
        .update(planChangeRequests)
        .set({
          status: decision.kind === 'APPLY' ? 'APPLIED' : 'REFUSED',
          decidedBy: admin.userId,
          decidedAt: this.now(),
        })
        .where(eq(planChangeRequests.id, id));
      await this.log(
        tx,
        admin,
        'plan_request.decided',
        { type: 'plan_request', id },
        {
          decision: decision.kind,
        },
      );
      return ok(null);
    });
  }

  // --- Convites --------------------------------------------------------------------------------

  /** `EXPIRED` e `PENDING` dependem da data: pendente vencido é `EXPIRED`. */
  private statusFilter(status: AdminInvitation['state'] | undefined, now: Date) {
    if (status === undefined) return undefined;
    const at = sql`${now.toISOString()}::timestamptz`;
    if (status === 'EXPIRED') {
      return and(eq(invitations.status, 'PENDING'), sql`${invitations.expiresAt} <= ${at}`);
    }
    if (status === 'PENDING') {
      return and(eq(invitations.status, 'PENDING'), sql`${invitations.expiresAt} > ${at}`);
    }
    return eq(invitations.status, status);
  }

  async listInvitations(
    admin: Admin,
    query: {
      limit: number;
      cursor?: string;
      status?: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
      kind?: InvitationKind;
    },
  ): Promise<Page<AdminInvitation> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const now = this.now();

    const rows = await withContext(this.db, adminContext(admin), (tx) =>
      tx
        .select({ invitation: invitations, storeName: stores.name })
        .from(invitations)
        .leftJoin(stores, eq(stores.id, invitations.storeId))
        .where(
          and(
            this.statusFilter(query.status, now),
            query.kind === 'ACCOUNT' ? sql`${invitations.storeId} IS NULL` : undefined,
            query.kind === 'OWNER' ? eq(invitations.role, 'OWNER') : undefined,
            query.kind === 'STAFF' ? eq(invitations.role, 'STAFF') : undefined,
            position === null
              ? undefined
              : sql`(${invitations.createdAt}, ${invitations.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(invitations.createdAt), desc(invitations.id))
        .limit(query.limit + 1),
    );
    return toPage(
      rows.map(({ invitation, storeName }) => ({
        id: invitation.id,
        email: invitation.email,
        kind: invitation.role === null ? 'ACCOUNT' : invitation.role,
        store:
          invitation.storeId === null ? null : { id: invitation.storeId, name: storeName ?? '' },
        state:
          invitation.status === 'PENDING' && invitation.expiresAt <= now
            ? 'EXPIRED'
            : invitation.status,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
      })),
      query.limit,
    );
  }

  /** Reenvia: o convite novo revoga o anterior. Respeita o intervalo mínimo entre envios. */
  async resendInvitation(admin: Admin, id: string): Promise<AdminResult<{ id: string }>> {
    const [row] = await withContext(this.db, adminContext(admin), (tx) =>
      tx.select().from(invitations).where(eq(invitations.id, id)).limit(1),
    );
    if (row === undefined) return fail('NOT_FOUND');
    if (row.status !== 'PENDING') return fail('NOT_PENDING');
    const elapsedMs = Math.max(0, this.now().getTime() - row.createdAt.getTime());
    if (elapsedMs < this.resendSeconds * 1000) return fail('TOO_SOON');

    const created = await this.invitationService.create({
      email: row.email,
      ...(row.storeId === null || row.role === null
        ? {}
        : { storeId: row.storeId, role: row.role }),
      permissions: row.permissions,
      invitedBy: admin.userId,
    });
    if (!created.ok)
      return fail(created.reason === 'USER_SUSPENDED' ? 'OWNER_SUSPENDED' : 'NOT_FOUND');
    await withContext(this.db, adminContext(admin), (tx) =>
      this.log(tx, admin, 'invitation.resent', { type: 'invitation', id: created.invitationId }),
    );
    return ok({ id: created.invitationId });
  }

  async revokeInvitation(admin: Admin, id: string): Promise<AdminResult<null>> {
    return withContext(this.db, adminContext(admin), async (tx) => {
      const revoked = await tx
        .update(invitations)
        .set({ status: 'REVOKED' })
        .where(and(eq(invitations.id, id), eq(invitations.status, 'PENDING')))
        .returning({ id: invitations.id });
      if (revoked.length === 0) {
        const [exists] = await tx
          .select({ id: invitations.id })
          .from(invitations)
          .where(eq(invitations.id, id));
        return exists === undefined ? fail('NOT_FOUND') : fail('NOT_PENDING');
      }
      await this.log(tx, admin, 'invitation.revoked', { type: 'invitation', id });
      return ok(null);
    });
  }

  // --- Solicitações de acesso ------------------------------------------------------------------

  async listAccessRequests(
    admin: Admin,
    query: { limit: number; cursor?: string; status?: AccessRequestView['status'] },
  ): Promise<Page<AccessRequestView> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const rows = await withContext(this.db, adminContext(admin), (tx) =>
      tx
        .select()
        .from(accessRequests)
        .where(
          and(
            query.status === undefined ? undefined : eq(accessRequests.status, query.status),
            position === null
              ? undefined
              : sql`(${accessRequests.createdAt}, ${accessRequests.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(accessRequests.createdAt), desc(accessRequests.id))
        .limit(query.limit + 1),
    );
    return toPage(
      rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        whatsapp: r.whatsapp,
        storeName: r.storeName,
        message: r.message,
        status: r.status,
        decidedAt: r.decidedAt,
        convertedStoreId: r.convertedStoreId,
        createdAt: r.createdAt,
      })),
      query.limit,
    );
  }

  /** Recusa o pedido. Não envia nada ao solicitante. */
  async refuseAccessRequest(admin: Admin, id: string): Promise<AdminResult<null>> {
    return withContext(this.db, adminContext(admin), async (tx) => {
      const [current] = await tx
        .select({ status: accessRequests.status })
        .from(accessRequests)
        .where(eq(accessRequests.id, id))
        .for('update');
      if (current === undefined) return fail('NOT_FOUND');
      if (current.status !== 'PENDING') return fail('REQUEST_NOT_PENDING');
      await tx
        .update(accessRequests)
        .set({ status: 'REFUSED', decidedBy: admin.userId, decidedAt: this.now() })
        .where(eq(accessRequests.id, id));
      await this.log(tx, admin, 'access_request.refused', { type: 'access_request', id });
      return ok(null);
    });
  }

  // --- Painel e log ----------------------------------------------------------------------------

  /** KPIs agregados da plataforma. Só conta contas, lojas e convites: nunca dados internos. */
  async overview(admin: Admin): Promise<Overview> {
    return withContext(this.db, adminContext(admin), async (tx) => {
      const totals = await tx.execute<{
        active_users: string;
        stores: string;
        pending_invitations: string;
        new_requests: string;
        plan_requests: string;
      }>(sql`
        SELECT (SELECT count(*) FROM users WHERE status = 'ACTIVE') AS active_users,
               (SELECT count(*) FROM stores) AS stores,
               (SELECT count(*) FROM invitations WHERE status = 'PENDING' AND expires_at > now()) AS pending_invitations,
               (SELECT count(*) FROM access_requests WHERE status = 'PENDING') AS new_requests,
               (SELECT count(*) FROM plan_change_requests WHERE status = 'PENDING') AS plan_requests
      `);
      const t = totals.rows[0];
      const down = await tx
        .select({
          id: stores.id,
          name: stores.name,
          city: stores.city,
          status: stores.whatsappStatus,
        })
        .from(stores)
        .where(ne(stores.whatsappStatus, 'ONLINE'))
        .orderBy(stores.name)
        .limit(100);
      return {
        activeUsers: Number(t?.active_users ?? 0),
        stores: Number(t?.stores ?? 0),
        pendingInvitations: Number(t?.pending_invitations ?? 0),
        newAccessRequests: Number(t?.new_requests ?? 0),
        pendingPlanRequests: Number(t?.plan_requests ?? 0),
        disconnectedStores: down.map((s) => ({
          id: s.id,
          name: s.name,
          city: s.city,
          whatsappStatus: s.status === 'QR_READY' ? 'QR_READY' : 'OFFLINE',
        })),
      };
    });
  }

  async activityLog(
    admin: Admin,
    query: { limit: number; cursor?: string },
  ): Promise<
    | Page<{
        id: string;
        createdAt: Date;
        actorUserId: string | null;
        action: string;
        targetType: string | null;
        targetId: string | null;
        details: Record<string, unknown>;
      }>
    | 'INVALID_CURSOR'
  > {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const rows = await withContext(this.db, adminContext(admin), (tx) =>
      tx
        .select()
        .from(adminActivityLog)
        .where(
          position === null
            ? undefined
            : sql`(${adminActivityLog.createdAt}, ${adminActivityLog.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
        )
        .orderBy(desc(adminActivityLog.createdAt), desc(adminActivityLog.id))
        .limit(query.limit + 1),
    );
    return toPage(rows, query.limit);
  }
}
