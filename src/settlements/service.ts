import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { withContext, type Db, type Tx } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';

const { settlements, settlementItems, customers, cardsInventory, shipments } = schema;

interface Context {
  storeId: string;
  userId: string;
}

export type SettlementStatus = (typeof schema.settlementStatus.enumValues)[number];

export interface SettlementItemView {
  auctionId: string;
  amount: string;
  card: { id: string; shortCode: string; name: string };
}

export interface SettlementView {
  id: string;
  status: SettlementStatus;
  customer: { id: string; name: string; kind: 'VISITOR' | 'CUSTOMER'; phone: string };
  itemsTotal: string;
  shippingCost: string;
  totalAmount: string;
  paidAt: Date | null;
  createdAt: Date;
  shipment: { id: string; status: string; trackingCode: string | null } | null;
  items: SettlementItemView[];
}

export interface AwaitingGroup {
  customer: { id: string; name: string; kind: 'VISITOR' | 'CUSTOMER' };
  subtotal: string;
  items: (SettlementItemView & { endedAt: Date })[];
}

export type SettlementFailure =
  'NOT_FOUND' | 'CUSTOMER_NOT_FOUND' | 'AUCTION_NOT_ELIGIBLE' | 'NOT_PENDING';

export type SettlementResult =
  { ok: true; settlement: SettlementView } | { ok: false; reason: SettlementFailure };

export interface ListQuery {
  limit: number;
  cursor?: string;
  status?: SettlementStatus;
  customerId?: string;
}

/** Linha de leilão encerrado com vencedor, já sem acerto. */
interface WonRow extends Record<string, unknown> {
  auction_id: string;
  ended_at: Date;
  amount: string;
  card_id: string;
  short_code: string;
  name: string;
  customer_id: string;
  customer_name: string;
  is_visitor: boolean;
}

const kindOf = (isVisitor: boolean): 'VISITOR' | 'CUSTOMER' => (isVisitor ? 'VISITOR' : 'CUSTOMER');

/**
 * Acertos (ADR 0002 e 0013): a plataforma não cobra nem garante pagamento. A loja agrupa o que o
 * comprador ganhou, informa o frete e marca como pago quando recebe por fora.
 */
export class SettlementService {
  constructor(private readonly db: Db) {}

  /** Vira o relógio da loja: um leilão que acabou agora já pode entrar num acerto. */
  private async advance(tx: Tx, storeId: string): Promise<void> {
    await tx.execute(sql`SELECT * FROM advance_auctions(${storeId}::uuid)`);
  }

  /** Compradores com leilões ganhos e ainda fora de qualquer acerto (a fila "a acertar"). */
  async awaiting(context: Context): Promise<AwaitingGroup[]> {
    return withContext(this.db, context, async (tx) => {
      await this.advance(tx, context.storeId);
      const result = await tx.execute<WonRow>(sql`
        SELECT a.id AS auction_id, a.end_time AS ended_at, b.amount, c.id AS card_id,
               c.short_code, t.name, cu.id AS customer_id, cu.name AS customer_name, cu.is_visitor
          FROM auctions a
          JOIN bids b ON b.id = a.winning_bid_id AND b.store_id = a.store_id
          JOIN customers cu ON cu.id = b.customer_id AND cu.store_id = a.store_id
          JOIN cards_inventory c ON c.id = a.card_id AND c.store_id = a.store_id
          JOIN tcgdex_catalog t ON t.id = c.tcgdex_id
         WHERE a.store_id = ${context.storeId}::uuid AND a.status = 'FINISHED'
           AND NOT EXISTS (SELECT 1 FROM settlement_items si WHERE si.auction_id = a.id)
         ORDER BY cu.name, cu.id, a.end_time, a.id
      `);
      const groups = new Map<string, AwaitingGroup & { cents: number }>();
      for (const row of result.rows) {
        const group = groups.get(row.customer_id) ?? {
          customer: { id: row.customer_id, name: row.customer_name, kind: kindOf(row.is_visitor) },
          subtotal: '0.00',
          items: [],
          cents: 0,
        };
        group.cents += Math.round(Number(row.amount) * 100);
        group.items.push({
          auctionId: row.auction_id,
          amount: row.amount,
          card: { id: row.card_id, shortCode: row.short_code, name: row.name },
          endedAt: new Date(row.ended_at),
        });
        groups.set(row.customer_id, group);
      }
      return [...groups.values()].map(({ cents, ...group }) => ({
        ...group,
        subtotal: (cents / 100).toFixed(2),
      }));
    });
  }

  private async view(tx: Tx, storeId: string, id: string): Promise<SettlementView | null> {
    const [row] = await tx
      .select({ settlement: settlements, customer: customers, shipment: shipments })
      .from(settlements)
      .innerJoin(
        customers,
        and(eq(customers.id, settlements.customerId), eq(customers.storeId, storeId)),
      )
      .leftJoin(
        shipments,
        and(eq(shipments.settlementId, settlements.id), eq(shipments.storeId, storeId)),
      )
      .where(and(eq(settlements.id, id), eq(settlements.storeId, storeId)))
      .limit(1);
    if (row === undefined) return null;

    const items = await tx.execute<{
      auction_id: string;
      amount: string;
      card_id: string;
      short_code: string;
      name: string;
    }>(sql`
      SELECT si.auction_id, si.amount, c.id AS card_id, c.short_code, t.name
        FROM settlement_items si
        JOIN cards_inventory c ON c.id = si.card_id AND c.store_id = si.store_id
        JOIN tcgdex_catalog t ON t.id = c.tcgdex_id
       WHERE si.settlement_id = ${id}::uuid AND si.store_id = ${storeId}::uuid
       ORDER BY c.short_code
    `);
    const itemsTotal = await tx.execute<{ total: string }>(sql`
      SELECT coalesce(sum(amount), 0)::numeric(12, 2) AS total
        FROM settlement_items WHERE settlement_id = ${id}::uuid AND store_id = ${storeId}::uuid
    `);
    return {
      id: row.settlement.id,
      status: row.settlement.status,
      customer: {
        id: row.customer.id,
        name: row.customer.name,
        kind: kindOf(row.customer.isVisitor),
        phone: row.customer.phone,
      },
      itemsTotal: itemsTotal.rows[0]?.total ?? '0.00',
      shippingCost: row.settlement.shippingCost,
      totalAmount: row.settlement.totalAmount,
      paidAt: row.settlement.paidAt,
      createdAt: row.settlement.createdAt,
      shipment:
        row.shipment === null
          ? null
          : {
              id: row.shipment.id,
              status: row.shipment.status,
              trackingCode: row.shipment.trackingCode,
            },
      items: items.rows.map((item) => ({
        auctionId: item.auction_id,
        amount: item.amount,
        card: { id: item.card_id, shortCode: item.short_code, name: item.name },
      })),
    };
  }

  /**
   * Cria o acerto de um comprador com os leilões que ele ganhou. Trava as linhas dos leilões:
   * dois acertos simultâneos com o mesmo leilão não passam.
   */
  async create(
    context: Context,
    input: { customerId: string; auctionIds: string[]; shippingCost: string },
  ): Promise<SettlementResult> {
    const ids = [...new Set(input.auctionIds)];
    return withContext(this.db, context, async (tx) => {
      const [buyer] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, input.customerId), eq(customers.storeId, context.storeId)))
        .limit(1);
      if (buyer === undefined) return { ok: false, reason: 'CUSTOMER_NOT_FOUND' } as const;

      await this.advance(tx, context.storeId);
      const idList = sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const eligible = await tx.execute<{
        auction_id: string;
        card_id: string;
        amount: string;
      }>(sql`
        SELECT a.id AS auction_id, a.card_id, b.amount
          FROM auctions a
          JOIN bids b ON b.id = a.winning_bid_id AND b.store_id = a.store_id
         WHERE a.store_id = ${context.storeId}::uuid AND a.id IN (${idList})
           AND a.status = 'FINISHED' AND b.customer_id = ${input.customerId}::uuid
         ORDER BY a.id
           FOR UPDATE OF a
      `);
      // Depois do lock, em outro comando: ele enxerga o acerto que outra transação acabou de gravar.
      const settled = await tx.execute(
        sql`SELECT 1 FROM settlement_items WHERE auction_id IN (${idList})`,
      );
      if (eligible.rows.length !== ids.length || settled.rows.length > 0) {
        return { ok: false, reason: 'AUCTION_NOT_ELIGIBLE' } as const;
      }

      const total = await tx.execute<{ total: string }>(sql`
        SELECT (${eligible.rows.reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0)}::numeric / 100
                + ${input.shippingCost}::numeric)::numeric(12, 2) AS total
      `);
      const [created] = await tx
        .insert(settlements)
        .values({
          storeId: context.storeId,
          customerId: input.customerId,
          shippingCost: input.shippingCost,
          totalAmount: total.rows[0]?.total ?? '0',
        })
        .returning({ id: settlements.id });
      if (created === undefined) throw new Error('o acerto não foi criado');
      await tx.insert(settlementItems).values(
        eligible.rows.map((row) => ({
          storeId: context.storeId,
          settlementId: created.id,
          auctionId: row.auction_id,
          cardId: row.card_id,
          amount: row.amount,
        })),
      );
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'settlement.created',
        targetType: 'settlement',
        targetId: created.id,
        details: { customer_id: input.customerId, items: ids.length },
      });
      const settlement = await this.view(tx, context.storeId, created.id);
      if (settlement === null) throw new Error('o acerto criado não foi encontrado');
      return { ok: true, settlement } as const;
    });
  }

  async list(context: Context, query: ListQuery): Promise<Page<SettlementView> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    return withContext(this.db, context, async (tx) => {
      const rows = await tx
        .select({ id: settlements.id, createdAt: settlements.createdAt })
        .from(settlements)
        .where(
          and(
            eq(settlements.storeId, context.storeId),
            query.status === undefined ? undefined : eq(settlements.status, query.status),
            query.customerId === undefined
              ? undefined
              : eq(settlements.customerId, query.customerId),
            position === null
              ? undefined
              : sql`(${settlements.createdAt}, ${settlements.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(settlements.createdAt), desc(settlements.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit);
      const items: SettlementView[] = [];
      for (const { id } of page.items) {
        const view = await this.view(tx, context.storeId, id);
        if (view !== null) items.push(view);
      }
      return { items, nextCursor: page.nextCursor };
    });
  }

  async get(context: Context, id: string): Promise<SettlementView | null> {
    return withContext(this.db, context, (tx) => this.view(tx, context.storeId, id));
  }

  private async lock(tx: Tx, storeId: string, id: string) {
    const [row] = await tx
      .select()
      .from(settlements)
      .where(and(eq(settlements.id, id), eq(settlements.storeId, storeId)))
      .for('update')
      .limit(1);
    return row;
  }

  /** Muda o frete enquanto o acerto está pendente; o total acompanha. */
  async setShipping(context: Context, id: string, shippingCost: string): Promise<SettlementResult> {
    return withContext(this.db, context, async (tx) => {
      const current = await this.lock(tx, context.storeId, id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (current.status !== 'PENDING') return { ok: false, reason: 'NOT_PENDING' } as const;

      await tx.execute(sql`
        UPDATE settlements s
           SET shipping_cost = ${shippingCost}::numeric,
               total_amount = (SELECT coalesce(sum(amount), 0) FROM settlement_items
                                WHERE settlement_id = s.id AND store_id = s.store_id)
                              + ${shippingCost}::numeric
         WHERE s.id = ${id}::uuid AND s.store_id = ${context.storeId}::uuid
      `);
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'settlement.shipping_updated',
        targetType: 'settlement',
        targetId: id,
      });
      const settlement = await this.view(tx, context.storeId, id);
      if (settlement === null) throw new Error('o acerto editado não foi encontrado');
      return { ok: true, settlement } as const;
    });
  }

  /**
   * Marca como pago (só a loja; "já paguei" do comprador nunca faz isto). As cartas viram vendidas
   * e entra na fila de envios.
   */
  async markPaid(context: Context, id: string): Promise<SettlementResult> {
    return withContext(this.db, context, async (tx) => {
      const current = await this.lock(tx, context.storeId, id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (current.status !== 'PENDING') return { ok: false, reason: 'NOT_PENDING' } as const;

      await tx
        .update(settlements)
        .set({ status: 'PAID', paidAt: new Date() })
        .where(eq(settlements.id, id));
      await tx
        .update(cardsInventory)
        .set({ status: 'SOLD', updatedAt: new Date() })
        .where(
          and(
            eq(cardsInventory.storeId, context.storeId),
            inArray(
              cardsInventory.id,
              tx
                .select({ id: settlementItems.cardId })
                .from(settlementItems)
                .where(eq(settlementItems.settlementId, id)),
            ),
          ),
        );
      await tx.insert(shipments).values({ storeId: context.storeId, settlementId: id });
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'settlement.paid',
        targetType: 'settlement',
        targetId: id,
      });
      const settlement = await this.view(tx, context.storeId, id);
      if (settlement === null) throw new Error('o acerto pago não foi encontrado');
      return { ok: true, settlement } as const;
    });
  }

  /** Desfaz um acerto pendente (errou o comprador ou os itens). Os leilões voltam à fila. */
  async remove(
    context: Context,
    id: string,
  ): Promise<{ ok: true } | { ok: false; reason: SettlementFailure }> {
    return withContext(this.db, context, async (tx) => {
      const current = await this.lock(tx, context.storeId, id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (current.status !== 'PENDING') return { ok: false, reason: 'NOT_PENDING' } as const;

      await tx.delete(settlements).where(eq(settlements.id, id));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'settlement.deleted',
        targetType: 'settlement',
        targetId: id,
        details: { customer_id: current.customerId },
      });
      return { ok: true } as const;
    });
  }
}
