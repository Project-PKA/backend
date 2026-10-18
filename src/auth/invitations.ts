import { and, desc, eq, sql } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import type { AuthConfig } from '../config/env.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';
import { hashToken, newToken } from './crypto.js';
import type { EmailSender } from './email.js';
import { effectivePermissions, normalizePermissions, type StoreRole } from './permissions.js';
import { normalizeEmail } from './service.js';

const { users, invitations, stores, storeMembers } = schema;

export interface CreateInvitationInput {
  email: string;
  /** Vazio = convite só de conta (ex.: administrador cadastrando usuário). */
  storeId?: string;
  role?: StoreRole;
  permissions?: unknown;
  invitedBy: string | null;
}

export interface InvitationPreview {
  email: string;
  storeName: string | null;
  role: StoreRole | null;
  permissions: Record<string, boolean> | null;
  expiresAt: Date;
}

export type CreateInvitationResult =
  | { ok: true; invitationId: string; expiresAt: Date }
  | { ok: false; reason: 'USER_SUSPENDED' | 'ROLE_REQUIRED' | 'ALREADY_MEMBER' };

export type InvitationState = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface InvitationItem {
  id: string;
  email: string;
  role: StoreRole | null;
  permissions: Record<string, boolean>;
  state: InvitationState;
  expiresAt: Date;
  createdAt: Date;
}

export type ResendResult =
  | { ok: true; invitationId: string }
  | { ok: false; reason: 'NOT_FOUND' | 'TOO_SOON' | 'NOT_PENDING' | CreateInvitationFailure };
type CreateInvitationFailure = Extract<CreateInvitationResult, { ok: false }>['reason'];

interface LoggerLike {
  error: (object: Record<string, unknown>, message: string) => void;
}

export interface InvitationServiceDeps {
  db: Db;
  config: AuthConfig;
  email: EmailSender;
  publicAppUrl: string;
  log: LoggerLike;
  now?: () => Date;
}

/**
 * Convites (ADR 0012). O token vai só por e-mail, no fragmento do link, e o banco
 * guarda apenas o hash. Convite vencido, usado ou revogado responde igual a
 * convite que nunca existiu. Ações de uma loja entram no log de atividades na
 * mesma transação.
 */
export class InvitationService {
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly deps: InvitationServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async flush(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  async create(input: CreateInvitationInput): Promise<CreateInvitationResult> {
    const { db, config } = this.deps;
    if ((input.storeId === undefined) !== (input.role === undefined)) {
      return { ok: false, reason: 'ROLE_REQUIRED' };
    }
    const email = normalizeEmail(input.email);
    const now = this.now();
    const token = newToken();
    const expiresAt = new Date(now.getTime() + config.invitationTtlDays * 86_400_000);
    const permissions = normalizePermissions(input.permissions);

    // Convite de loja roda com o contexto dela, para o log passar pelo RLS.
    const created = await withContext(db, { storeId: input.storeId }, async (tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing?.status === 'SUSPENDED') return { ok: false, reason: 'USER_SUSPENDED' } as const;

      if (existing !== undefined && input.storeId !== undefined) {
        const [member] = await tx
          .select({ id: storeMembers.id })
          .from(storeMembers)
          .where(and(eq(storeMembers.storeId, input.storeId), eq(storeMembers.userId, existing.id)))
          .limit(1);
        if (member !== undefined) return { ok: false, reason: 'ALREADY_MEMBER' } as const;
      }
      if (existing === undefined) await tx.insert(users).values({ email, status: 'INVITED' });

      // Um convite novo substitui o anterior para a mesma pessoa e loja.
      await tx
        .update(invitations)
        .set({ status: 'REVOKED' })
        .where(
          and(
            eq(invitations.email, email),
            eq(invitations.status, 'PENDING'),
            input.storeId === undefined ? undefined : eq(invitations.storeId, input.storeId),
          ),
        );

      const [row] = await tx
        .insert(invitations)
        .values({
          tokenHash: hashToken(config.refreshPepper, 'invitation', token),
          email,
          storeId: input.storeId ?? null,
          role: input.role ?? null,
          permissions,
          invitedBy: input.invitedBy,
          expiresAt,
        })
        .returning({ id: invitations.id });
      if (row === undefined) throw new Error('o convite não foi criado');

      if (input.storeId !== undefined) {
        await recordActivity(tx, {
          storeId: input.storeId,
          actorUserId: input.invitedBy,
          action: 'invitation.sent',
          targetType: 'invitation',
          targetId: row.id,
          details: { role: input.role ?? null },
        });
      }
      return { ok: true, invitationId: row.id } as const;
    });
    if (!created.ok) return created;

    const storeName = input.storeId === undefined ? null : await this.storeName(input.storeId);
    const task = this.deps.email
      .sendInvitation({
        to: email,
        link: `${this.deps.publicAppUrl}/convite#token=${token}`,
        storeName,
        role: input.role ?? null,
        expiresAt,
      })
      .catch((err: unknown) => {
        this.deps.log.error({ err }, 'falha ao enviar convite');
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);

    return { ok: true, invitationId: created.invitationId, expiresAt };
  }

  /** Convites de uma loja, do mais novo para o mais antigo. Vencido aparece como `EXPIRED`. */
  async listForStore(
    context: { storeId: string },
    query: { limit: number; cursor?: string },
  ): Promise<Page<InvitationItem> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const now = this.now();

    const rows = await this.deps.db
      .select()
      .from(invitations)
      .where(
        and(
          eq(invitations.storeId, context.storeId),
          position === null
            ? undefined
            : sql`(${invitations.createdAt}, ${invitations.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
        ),
      )
      .orderBy(desc(invitations.createdAt), desc(invitations.id))
      .limit(query.limit + 1);

    return toPage(
      rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        permissions: row.permissions,
        state: row.status === 'PENDING' && row.expiresAt <= now ? 'EXPIRED' : row.status,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      })),
      query.limit,
    );
  }

  /** Revoga um convite pendente da loja. `false` se não existir, for de outra loja ou já estiver usado. */
  async revoke(
    context: { storeId: string; userId: string },
    invitationId: string,
  ): Promise<boolean> {
    return withContext(this.deps.db, context, async (tx) => {
      const updated = await tx
        .update(invitations)
        .set({ status: 'REVOKED' })
        .where(
          and(
            eq(invitations.id, invitationId),
            eq(invitations.storeId, context.storeId),
            eq(invitations.status, 'PENDING'),
          ),
        )
        .returning({ id: invitations.id });
      if (updated.length === 0) return false;
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'invitation.revoked',
        targetType: 'invitation',
        targetId: invitationId,
      });
      return true;
    });
  }

  /**
   * Reenvia: gera um token novo e revoga o anterior. Respeita um intervalo mínimo
   * desde o último envio, para o recurso não virar fonte de spam.
   */
  async resend(
    context: { storeId: string; userId: string },
    invitationId: string,
  ): Promise<ResendResult> {
    const { db, config } = this.deps;
    const [row] = await db
      .select()
      .from(invitations)
      .where(and(eq(invitations.id, invitationId), eq(invitations.storeId, context.storeId)))
      .limit(1);
    if (row === undefined) return { ok: false, reason: 'NOT_FOUND' };
    if (row.status !== 'PENDING') return { ok: false, reason: 'NOT_PENDING' };
    // `created_at` vem do relógio do banco e `now()` do da aplicação: uma pequena
    // diferença entre os dois não pode virar tempo negativo e bloquear o reenvio.
    const elapsedMs = Math.max(0, this.now().getTime() - row.createdAt.getTime());
    if (elapsedMs < config.invitationResendSeconds * 1000) {
      return { ok: false, reason: 'TOO_SOON' };
    }
    if (row.storeId === null || row.role === null) return { ok: false, reason: 'NOT_FOUND' };

    const created = await this.create({
      email: row.email,
      storeId: row.storeId,
      role: row.role,
      permissions: row.permissions,
      invitedBy: context.userId,
    });
    return created.ok ? { ok: true, invitationId: created.invitationId } : created;
  }

  /** Mostra o que o convite concede, sem aceitá-lo. `null` para qualquer problema. */
  async preview(token: string): Promise<InvitationPreview | null> {
    const row = await this.findUsable(token);
    if (row === null) return null;
    return {
      email: row.email,
      storeName: row.storeId === null ? null : await this.storeName(row.storeId),
      role: row.role,
      permissions: row.role === null ? null : effectivePermissions(row.role, row.permissions),
      expiresAt: row.expiresAt,
    };
  }

  /** Aceita o convite: ativa a conta e, se houver loja, cria a associação. */
  async accept(token: string): Promise<{ email: string; storeId: string | null } | null> {
    const { db, config } = this.deps;
    const now = this.now();
    const tokenHash = hashToken(config.refreshPepper, 'invitation', token);
    const found = await this.findUsable(token);
    if (found === null) return null;

    // A associação à loja passa pelo RLS: o contexto é o da loja do convite.
    return withContext(db, { storeId: found.storeId ?? undefined }, async (tx) => {
      const [row] = await tx
        .select()
        .from(invitations)
        .where(eq(invitations.tokenHash, tokenHash))
        .for('update')
        .limit(1);
      if (row?.status !== 'PENDING' || row.expiresAt <= now) return null;

      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.email, row.email))
        .for('update')
        .limit(1);
      if (user === undefined || user.status === 'SUSPENDED') return null;

      await tx.update(users).set({ status: 'ACTIVE' }).where(eq(users.id, user.id));
      await tx
        .update(invitations)
        .set({ status: 'ACCEPTED', acceptedAt: now })
        .where(eq(invitations.id, row.id));
      if (row.storeId !== null && row.role !== null) {
        const inserted = await tx
          .insert(storeMembers)
          .values({
            storeId: row.storeId,
            userId: user.id,
            role: row.role,
            permissions: normalizePermissions(row.permissions),
          })
          .onConflictDoNothing()
          .returning({ id: storeMembers.id });
        if (inserted.length > 0) {
          await recordActivity(tx, {
            storeId: row.storeId,
            actorUserId: user.id,
            action: 'member.joined',
            targetType: 'member',
            targetId: inserted[0]?.id,
            details: { role: row.role },
          });
        }
      }
      return { email: row.email, storeId: row.storeId };
    });
  }

  private async findUsable(token: string) {
    const { db, config } = this.deps;
    const [row] = await db
      .select()
      .from(invitations)
      .where(eq(invitations.tokenHash, hashToken(config.refreshPepper, 'invitation', token)))
      .limit(1);
    if (row?.status !== 'PENDING' || row.expiresAt <= this.now()) return null;
    return row;
  }

  private async storeName(storeId: string): Promise<string | null> {
    return withContext(this.deps.db, { storeId }, async (tx) => {
      const [store] = await tx
        .select({ name: stores.name })
        .from(stores)
        .where(eq(stores.id, storeId))
        .limit(1);
      return store?.name ?? null;
    });
  }
}
