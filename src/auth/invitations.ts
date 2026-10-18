import { and, eq } from 'drizzle-orm';

import type { AuthConfig } from '../config/env.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { hashToken, newToken } from './crypto.js';
import type { EmailSender } from './email.js';
import { normalizeEmail } from './service.js';
import { effectivePermissions, normalizePermissions, type StoreRole } from './permissions.js';

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
  { ok: true; invitationId: string } | { ok: false; reason: 'USER_SUSPENDED' | 'ROLE_REQUIRED' };

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
 * convite que nunca existiu.
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

    const created = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(users).where(eq(users.email, email)).limit(1);
      if (existing?.status === 'SUSPENDED') return null;
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
      return row?.id ?? null;
    });
    if (created === null) return { ok: false, reason: 'USER_SUSPENDED' };

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

    return { ok: true, invitationId: created };
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
        await tx
          .insert(storeMembers)
          .values({
            storeId: row.storeId,
            userId: user.id,
            role: row.role,
            permissions: normalizePermissions(row.permissions),
          })
          .onConflictDoNothing();
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
