import { and, desc, eq, sql } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';

const { shipments, settlements, customers } = schema;

export type ShipmentStatus = (typeof schema.shipmentStatus.enumValues)[number];

interface Context {
  storeId: string;
  userId: string;
}

export interface ShipmentView {
  id: string;
  settlementId: string;
  status: ShipmentStatus;
  trackingCode: string | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  /** A loja precisa do endereço para enviar. O CPF nunca sai. */
  recipient: {
    id: string;
    name: string;
    phone: string;
    address: {
      zip: string | null;
      street: string | null;
      number: string | null;
      comp: string | null;
      city: string | null;
      state: string | null;
    };
  };
  totalAmount: string;
}

export type ShipmentFailure = 'NOT_FOUND' | 'INVALID_TRANSITION' | 'TRACKING_REQUIRED';

export type ShipmentResult =
  { ok: true; shipment: ShipmentView } | { ok: false; reason: ShipmentFailure };

export interface ShipmentUpdate {
  status?: ShipmentStatus;
  trackingCode?: string | null;
}

/** Só avança: a enviar → enviado → entregue. */
const NEXT: Record<ShipmentStatus, ShipmentStatus[]> = {
  TO_SHIP: ['SHIPPED'],
  SHIPPED: ['DELIVERED'],
  DELIVERED: [],
};

const select = {
  shipment: shipments,
  customer: customers,
  total: settlements.totalAmount,
} as const;

function toView(row: {
  shipment: typeof shipments.$inferSelect;
  customer: typeof customers.$inferSelect;
  total: string;
}): ShipmentView {
  const { shipment, customer } = row;
  return {
    id: shipment.id,
    settlementId: shipment.settlementId,
    status: shipment.status,
    trackingCode: shipment.trackingCode,
    shippedAt: shipment.shippedAt,
    deliveredAt: shipment.deliveredAt,
    createdAt: shipment.createdAt,
    recipient: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: {
        zip: customer.addressZip,
        street: customer.addressStreet,
        number: customer.addressNumber,
        comp: customer.addressComp,
        city: customer.addressCity,
        state: customer.addressState,
      },
    },
    totalAmount: row.total,
  };
}

/**
 * Fila de envios das vendas pagas. A plataforma não manda mensagem ao comprador (ADR 0006): a loja
 * avisa por conta própria e aqui só registra o rastreio e o andamento.
 */
export class ShipmentService {
  constructor(private readonly db: Db) {}

  async list(
    context: Context,
    query: { limit: number; cursor?: string; status?: ShipmentStatus },
  ): Promise<Page<ShipmentView> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const rows = await withContext(this.db, context, (tx) =>
      tx
        .select(select)
        .from(shipments)
        .innerJoin(
          settlements,
          and(eq(settlements.id, shipments.settlementId), eq(settlements.storeId, context.storeId)),
        )
        .innerJoin(
          customers,
          and(eq(customers.id, settlements.customerId), eq(customers.storeId, context.storeId)),
        )
        .where(
          and(
            eq(shipments.storeId, context.storeId),
            query.status === undefined ? undefined : eq(shipments.status, query.status),
            position === null
              ? undefined
              : sql`(${shipments.createdAt}, ${shipments.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(shipments.createdAt), desc(shipments.id))
        .limit(query.limit + 1),
    );
    const page = toPage(
      rows.map((row) => ({ ...toView(row), createdAt: row.shipment.createdAt })),
      query.limit,
    );
    return page;
  }

  async update(context: Context, id: string, input: ShipmentUpdate): Promise<ShipmentResult> {
    return withContext(this.db, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(shipments)
        .where(and(eq(shipments.id, id), eq(shipments.storeId, context.storeId)))
        .for('update')
        .limit(1);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;

      const target = input.status ?? current.status;
      if (target !== current.status && !NEXT[current.status].includes(target)) {
        return { ok: false, reason: 'INVALID_TRANSITION' } as const;
      }
      // Rastreio só muda até a entrega; ao despachar, é obrigatório.
      if (current.status === 'DELIVERED' && input.trackingCode !== undefined) {
        return { ok: false, reason: 'INVALID_TRANSITION' } as const;
      }
      const tracking = input.trackingCode === undefined ? current.trackingCode : input.trackingCode;
      if (target !== 'TO_SHIP' && (tracking === null || tracking === '')) {
        return { ok: false, reason: 'TRACKING_REQUIRED' } as const;
      }

      const now = new Date();
      await tx
        .update(shipments)
        .set({
          status: target,
          trackingCode: tracking,
          shippedAt: target === 'TO_SHIP' ? null : (current.shippedAt ?? now),
          deliveredAt: target === 'DELIVERED' ? (current.deliveredAt ?? now) : null,
          updatedAt: now,
        })
        .where(eq(shipments.id, id));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'shipment.updated',
        targetType: 'shipment',
        targetId: id,
        details: { from: current.status, to: target },
      });
      const [row] = await tx
        .select(select)
        .from(shipments)
        .innerJoin(settlements, eq(settlements.id, shipments.settlementId))
        .innerJoin(customers, eq(customers.id, settlements.customerId))
        .where(and(eq(shipments.id, id), eq(shipments.storeId, context.storeId)));
      if (row === undefined) throw new Error('o envio editado não foi encontrado');
      return { ok: true, shipment: toView(row) } as const;
    });
  }
}
