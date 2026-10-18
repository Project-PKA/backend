import { desc, eq, sql } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';

const { stores, planChangeRequests } = schema;

interface Context {
  storeId: string;
  userId: string;
}

/** Cada loja tem um grupo de WhatsApp (o bot conecta um só). */
export const GROUP_LIMIT = 1;

export interface PlanRequestView {
  id: string;
  requestedPlan: string | null;
  message: string | null;
  status: (typeof schema.planRequestStatus.enumValues)[number];
  decidedAt: Date | null;
  createdAt: Date;
}

export interface PlanOverview {
  plan: string;
  limits: { members: number; cards: number | null; groups: number };
  usage: { members: number; pendingInvitations: number; cards: number; groups: number };
  pendingRequest: PlanRequestView | null;
  recentRequests: PlanRequestView[];
}

const toRequest = (row: typeof planChangeRequests.$inferSelect): PlanRequestView => ({
  id: row.id,
  requestedPlan: row.requestedPlan,
  message: row.message,
  status: row.status,
  decidedAt: row.decidedAt,
  createdAt: row.createdAt,
});

/**
 * Plano da loja: o que está contratado, quanto já foi usado e o pedido de mudança. Não há
 * autoatendimento (produto.md, regra 17): quem muda o plano é a administração.
 */
export class PlanService {
  constructor(private readonly db: Db) {}

  async overview(context: Context): Promise<PlanOverview> {
    return withContext(this.db, context, async (tx) => {
      const [store] = await tx.select().from(stores).where(eq(stores.id, context.storeId)).limit(1);
      if (store === undefined) throw new Error('loja do contexto não encontrada');
      const usage = await tx.execute<{ members: string; pending: string; cards: string }>(sql`
        SELECT (SELECT count(*) FROM store_members WHERE store_id = ${context.storeId}::uuid) AS members,
               (SELECT count(*) FROM invitations WHERE store_id = ${context.storeId}::uuid
                   AND status = 'PENDING' AND expires_at > now()) AS pending,
               (SELECT count(*) FROM cards_inventory WHERE store_id = ${context.storeId}::uuid) AS cards
      `);
      const requests = await tx
        .select()
        .from(planChangeRequests)
        .where(eq(planChangeRequests.storeId, context.storeId))
        .orderBy(desc(planChangeRequests.createdAt), desc(planChangeRequests.id))
        .limit(5);
      const u = usage.rows[0];
      const pendingRow = requests.find((r) => r.status === 'PENDING');
      return {
        plan: store.plan,
        limits: { members: store.memberLimit, cards: store.cardLimit, groups: GROUP_LIMIT },
        usage: {
          members: Number(u?.members ?? 0),
          pendingInvitations: Number(u?.pending ?? 0),
          cards: Number(u?.cards ?? 0),
          groups: store.whatsappGroupId === null ? 0 : 1,
        },
        pendingRequest: pendingRow === undefined ? null : toRequest(pendingRow),
        recentRequests: requests.map(toRequest),
      };
    });
  }

  /**
   * Pede a mudança de plano à administração. Só há um pedido pendente por loja: pedir de novo
   * atualiza o que já está na fila. A administração enxerga pelo painel e pela lista de pedidos.
   */
  async requestChange(
    context: Context,
    input: { requestedPlan?: string; message?: string },
  ): Promise<PlanRequestView> {
    return withContext(this.db, context, async (tx) => {
      const [row] = await tx
        .insert(planChangeRequests)
        .values({
          storeId: context.storeId,
          requestedPlan: input.requestedPlan ?? null,
          message: input.message ?? null,
          requestedBy: context.userId,
        })
        .onConflictDoUpdate({
          target: planChangeRequests.storeId,
          targetWhere: eq(planChangeRequests.status, 'PENDING'),
          set: {
            requestedPlan: input.requestedPlan ?? null,
            message: input.message ?? null,
            requestedBy: context.userId,
          },
        })
        .returning();
      if (row === undefined) throw new Error('o pedido não foi gravado');
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'plan.change_requested',
        targetType: 'plan_request',
        targetId: row.id,
        details: { requested_plan: input.requestedPlan ?? null },
      });
      return toRequest(row);
    });
  }
}
