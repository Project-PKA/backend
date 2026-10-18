import { randomUUID } from 'node:crypto';

import { and, count, eq } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';

const { users, stores, storeMembers } = schema;

export interface StoreSummary {
  id: string;
  name: string;
  whatsappStatus: 'ONLINE' | 'OFFLINE' | 'QR_READY';
  inactivityDaysLimit: number | null;
  pixKey: string | null;
  showcaseEnabled: boolean;
  whatsappInviteUrl: string | null;
}

export type CreateStoreResult =
  { ok: true; store: StoreSummary } | { ok: false; reason: 'NOT_ALLOWED' | 'LIMIT_REACHED' };

export interface StorePatch {
  name?: string;
  /** `null` desliga a expulsão por inatividade. */
  inactivityDaysLimit?: number | null;
  /** Chave PIX mostrada ao comprador. `null` apaga. */
  pixKey?: string | null;
  /** Link de convite do grupo de WhatsApp. Fica público se a vitrine estiver ligada. */
  whatsappInviteUrl?: string | null;
  /** Liga ou desliga a vitrine pública (opt-in). */
  showcaseEnabled?: boolean;
  /** Quem liga a vitrine confirma que o link do grupo será público. */
  acknowledgePublicGroupLink?: boolean;
}

export type UpdateStoreResult =
  | { ok: true; store: StoreSummary }
  | { ok: false; reason: 'NOT_FOUND' | 'INVITE_URL_REQUIRED' | 'ACK_REQUIRED' };

const toSummary = (row: typeof stores.$inferSelect): StoreSummary => ({
  id: row.id,
  name: row.name,
  whatsappStatus: row.whatsappStatus,
  inactivityDaysLimit: row.inactivityDaysLimit,
  pixKey: row.pixKey,
  showcaseEnabled: row.showcaseEnabled,
  whatsappInviteUrl: row.whatsappInviteUrl,
});

/** Lojas: criação por conta própria (com permissão e limite) e edição pelo proprietário. */
export class StoreService {
  constructor(private readonly db: Db) {}

  /**
   * Cria uma loja e torna a pessoa proprietária. Exige a permissão global
   * `can_create_stores` e respeita `store_limit`, contado em **lojas em que a
   * pessoa é proprietária**. A linha do usuário fica travada durante a
   * transação, então duas criações simultâneas no limite não passam as duas.
   */
  async create(userId: string, name: string): Promise<CreateStoreResult> {
    const storeId = randomUUID();
    // O contexto leva o id novo: é o que a política de INSERT em `stores` confere.
    return withContext(this.db, { userId, storeId }, async (tx) => {
      const [user] = await tx
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .for('update')
        .limit(1);
      if (user?.status !== 'ACTIVE' || !user.canCreateStores) {
        return { ok: false, reason: 'NOT_ALLOWED' } as const;
      }

      const [owned] = await tx
        .select({ total: count() })
        .from(storeMembers)
        .where(and(eq(storeMembers.userId, userId), eq(storeMembers.role, 'OWNER')));
      if ((owned?.total ?? 0) >= user.storeLimit) {
        return { ok: false, reason: 'LIMIT_REACHED' } as const;
      }

      const [store] = await tx.insert(stores).values({ id: storeId, name }).returning();
      if (store === undefined) throw new Error('a loja não foi criada');
      await tx.insert(storeMembers).values({ storeId, userId, role: 'OWNER', permissions: {} });
      await recordActivity(tx, {
        storeId,
        actorUserId: userId,
        action: 'store.created',
        targetType: 'store',
        targetId: storeId,
      });
      return { ok: true, store: toSummary(store) } as const;
    });
  }

  /**
   * Edita a loja. Ligar a vitrine exige o link do grupo e a confirmação de que ele ficará público
   * (ADR 0014); desligar não exige nada.
   */
  async update(
    context: { storeId: string; userId: string },
    patch: StorePatch,
  ): Promise<UpdateStoreResult> {
    const values: Partial<typeof stores.$inferInsert> = {};
    if (patch.name !== undefined) values.name = patch.name;
    if (patch.inactivityDaysLimit !== undefined) {
      values.inactivityDaysLimit = patch.inactivityDaysLimit;
    }
    if (patch.pixKey !== undefined) values.pixKey = patch.pixKey;
    if (patch.whatsappInviteUrl !== undefined) values.whatsappInviteUrl = patch.whatsappInviteUrl;
    if (patch.showcaseEnabled !== undefined) values.showcaseEnabled = patch.showcaseEnabled;

    return withContext(this.db, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(stores)
        .where(eq(stores.id, context.storeId))
        .for('update');
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;

      const inviteUrl =
        patch.whatsappInviteUrl === undefined ? current.whatsappInviteUrl : patch.whatsappInviteUrl;
      const enabledAfter = patch.showcaseEnabled ?? current.showcaseEnabled;
      if (enabledAfter && inviteUrl === null) {
        return { ok: false, reason: 'INVITE_URL_REQUIRED' } as const;
      }
      const turningOn = patch.showcaseEnabled === true && !current.showcaseEnabled;
      if (turningOn && patch.acknowledgePublicGroupLink !== true) {
        return { ok: false, reason: 'ACK_REQUIRED' } as const;
      }

      const [store] = await tx
        .update(stores)
        .set(values)
        .where(eq(stores.id, context.storeId))
        .returning();
      if (store === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'store.updated',
        targetType: 'store',
        targetId: context.storeId,
        details: { fields: Object.keys(values) },
      });
      return { ok: true, store: toSummary(store) } as const;
    });
  }
}
