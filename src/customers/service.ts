import { and, desc, eq, exists, ilike, isNull, lt, or, sql, type SQL } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';
import { maskCpf, normalizeCep, normalizeCpf, normalizePhone } from './validation.js';

const { customers, cardsInventory, stores, bids, auctions, settlements } = schema;

interface Context {
  storeId: string;
  userId: string;
}

export interface Address {
  zip: string | null;
  street: string | null;
  number: string | null;
  comp: string | null;
  city: string | null;
  state: string | null;
}

export interface CustomerView {
  id: string;
  phone: string;
  name: string;
  email: string | null;
  /** Nunca o CPF inteiro. */
  cpfMasked: string | null;
  kind: 'VISITOR' | 'CUSTOMER';
  isBlacklisted: boolean;
  blacklistReason: string | null;
  lastInteractionAt: Date | null;
  address: Address;
  createdAt: Date;
}

export interface CustomerInput {
  phone?: string;
  name?: string;
  email?: string | null;
  cpf?: string | null;
  address?: Partial<Address>;
}

export type CustomerFailure =
  | 'NOT_FOUND'
  | 'PHONE_INVALID'
  | 'PHONE_TAKEN'
  | 'CPF_INVALID'
  | 'CEP_INVALID'
  | 'INACTIVITY_NOT_SET';

export type CustomerResult =
  { ok: true; customer: CustomerView } | { ok: false; reason: CustomerFailure };

export interface ListQuery {
  limit: number;
  cursor?: string;
  q?: string;
  kind?: 'VISITOR' | 'CUSTOMER';
  blacklisted?: boolean;
  inactive?: boolean;
  consignor?: boolean;
}

export interface SettlementView {
  id: string;
  status: 'PENDING' | 'PAID';
  totalAmount: string;
  items: number;
  paidAt: Date | null;
  createdAt: Date;
}

export interface BidHistoryItem {
  id: string;
  amount: string;
  createdAt: Date;
  auctionId: string;
  auctionStatus: string;
  won: boolean;
  card: { id: string; shortCode: string; name: string };
}

export interface ConsignmentItem {
  id: string;
  createdAt: Date;
  shortCode: string;
  name: string;
  cardStatus: string;
  commissionPct: string;
  saleAmount: string | null;
  commissionAmount: string | null;
  netAmount: string | null;
}

export interface ConsignmentWallet {
  items: Page<ConsignmentItem>;
  totals: { inStock: number; pendingNet: string; soldNet: string; commission: string };
}

function toView(row: typeof customers.$inferSelect): CustomerView {
  return {
    id: row.id,
    phone: row.phone,
    name: row.name,
    email: row.email,
    cpfMasked: maskCpf(row.cpf),
    kind: row.isVisitor ? 'VISITOR' : 'CUSTOMER',
    isBlacklisted: row.isBlacklisted,
    blacklistReason: row.blacklistReason,
    lastInteractionAt: row.lastInteractionAt,
    address: {
      zip: row.addressZip,
      street: row.addressStreet,
      number: row.addressNumber,
      comp: row.addressComp,
      city: row.addressCity,
      state: row.addressState,
    },
    createdAt: row.createdAt,
  };
}

/** Cliente completo = tem CPF e endereço (ADR 0005). Senão continua visitante. */
function isComplete(row: {
  cpf: string | null;
  addressZip: string | null;
  addressStreet: string | null;
  addressNumber: string | null;
  addressCity: string | null;
  addressState: string | null;
}): boolean {
  return [
    row.cpf,
    row.addressZip,
    row.addressStreet,
    row.addressNumber,
    row.addressCity,
    row.addressState,
  ].every((value) => value !== null && value !== '');
}

type Values = Partial<typeof customers.$inferInsert>;
type Normalized = { ok: true; values: Values } | { ok: false; reason: CustomerFailure };

function normalizeAddress(address: Partial<Address>): Normalized {
  const values: Values = {};
  if (address.zip !== undefined) {
    const zip = address.zip === null ? null : normalizeCep(address.zip);
    if (address.zip !== null && zip === null) return { ok: false, reason: 'CEP_INVALID' };
    values.addressZip = zip;
  }
  if (address.street !== undefined) values.addressStreet = address.street;
  if (address.number !== undefined) values.addressNumber = address.number;
  if (address.comp !== undefined) values.addressComp = address.comp;
  if (address.city !== undefined) values.addressCity = address.city;
  if (address.state !== undefined) values.addressState = address.state?.toUpperCase() ?? null;
  return { ok: true, values };
}

/** Valida e normaliza os campos informados (CPF, CEP e telefone, no servidor). */
function normalize(input: CustomerInput): Normalized {
  const values: Values = {};
  if (input.phone !== undefined) {
    const phone = normalizePhone(input.phone);
    if (phone === null) return { ok: false, reason: 'PHONE_INVALID' };
    values.phone = phone;
  }
  if (input.name !== undefined) values.name = input.name.trim();
  if (input.email !== undefined) {
    values.email = input.email === null ? null : input.email.trim().toLowerCase();
  }
  if (input.cpf !== undefined) {
    const cpf = input.cpf === null ? null : normalizeCpf(input.cpf);
    if (input.cpf !== null && cpf === null) return { ok: false, reason: 'CPF_INVALID' };
    values.cpf = cpf;
  }
  if (input.address === undefined) return { ok: true, values };
  const address = normalizeAddress(input.address);
  return address.ok ? { ok: true, values: { ...values, ...address.values } } : address;
}

/** Clientes e visitantes da loja. Tudo no contexto da loja (RLS) e com log de atividades. */
export class CustomerService {
  constructor(private readonly db: Db) {}

  async create(
    context: Context,
    input: CustomerInput & { phone: string; name: string },
  ): Promise<CustomerResult> {
    const parsed = normalize(input);
    if (!parsed.ok) return parsed;
    return withContext(this.db, context, async (tx) => {
      const merged = {
        ...parsed.values,
        cpf: parsed.values.cpf ?? null,
      } as typeof customers.$inferInsert;
      const [created] = await tx
        .insert(customers)
        .values({
          ...merged,
          storeId: context.storeId,
          isVisitor: !isComplete({
            cpf: merged.cpf ?? null,
            addressZip: merged.addressZip ?? null,
            addressStreet: merged.addressStreet ?? null,
            addressNumber: merged.addressNumber ?? null,
            addressCity: merged.addressCity ?? null,
            addressState: merged.addressState ?? null,
          }),
        })
        .onConflictDoNothing({ target: [customers.storeId, customers.phone] })
        .returning();
      if (created === undefined) return { ok: false, reason: 'PHONE_TAKEN' } as const;
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'customer.created',
        targetType: 'customer',
        targetId: created.id,
      });
      return { ok: true, customer: toView(created) } as const;
    });
  }

  async update(context: Context, id: string, input: CustomerInput): Promise<CustomerResult> {
    const parsed = normalize({
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.email === undefined ? {} : { email: input.email }),
      ...(input.cpf === undefined ? {} : { cpf: input.cpf }),
      ...(input.address === undefined ? {} : { address: input.address }),
    });
    if (!parsed.ok) return parsed;
    return withContext(this.db, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), eq(customers.storeId, context.storeId)))
        .for('update')
        .limit(1);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;

      const next = { ...current, ...parsed.values };
      const [updated] = await tx
        .update(customers)
        .set({ ...parsed.values, isVisitor: !isComplete(next), updatedAt: new Date() })
        .where(eq(customers.id, id))
        .returning();
      if (updated === undefined) throw new Error('o cliente não foi atualizado');
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'customer.updated',
        targetType: 'customer',
        targetId: id,
        // Só os nomes dos campos: nunca o valor (CPF, e-mail, endereço).
        details: { changed: Object.keys(parsed.values) },
      });
      return { ok: true, customer: toView(updated) } as const;
    });
  }

  async get(context: Context, id: string): Promise<CustomerView | null> {
    return withContext(this.db, context, async (tx) => {
      const [row] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.id, id), eq(customers.storeId, context.storeId)))
        .limit(1);
      return row === undefined ? null : toView(row);
    });
  }

  async list(
    context: Context,
    query: ListQuery,
  ): Promise<Page<CustomerView> | 'INVALID_CURSOR' | 'INACTIVITY_NOT_SET'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';

    return withContext(this.db, context, async (tx) => {
      const conditions: (SQL | undefined)[] = [eq(customers.storeId, context.storeId)];
      if (query.inactive === true) {
        const [store] = await tx
          .select({ limit: stores.inactivityDaysLimit })
          .from(stores)
          .where(eq(stores.id, context.storeId));
        if (store?.limit == null) return 'INACTIVITY_NOT_SET' as const;
        conditions.push(
          or(
            isNull(customers.lastInteractionAt),
            lt(customers.lastInteractionAt, sql`now() - make_interval(days => ${store.limit})`),
          ),
        );
      }
      if (query.kind !== undefined)
        conditions.push(eq(customers.isVisitor, query.kind === 'VISITOR'));
      if (query.blacklisted !== undefined)
        conditions.push(eq(customers.isBlacklisted, query.blacklisted));
      if (query.consignor === true) {
        conditions.push(
          exists(
            tx
              .select({ one: sql`1` })
              .from(cardsInventory)
              .where(eq(cardsInventory.consignorId, customers.id)),
          ),
        );
      }
      const q = query.q?.trim() ?? '';
      if (q !== '') {
        const digits = q.replaceAll(/\D/g, '');
        const escaped = q.replaceAll(/[\\%_]/g, '\\$&');
        conditions.push(
          or(
            sql`${customers.name} ILIKE ${'%' + escaped + '%'} ESCAPE '\\'`,
            digits.length >= 3 ? ilike(customers.phone, '%' + digits + '%') : undefined,
          ),
        );
      }
      if (position !== null) {
        conditions.push(
          sql`(${customers.createdAt}, ${customers.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
        );
      }
      const rows = await tx
        .select()
        .from(customers)
        .where(and(...conditions))
        .orderBy(desc(customers.createdAt), desc(customers.id))
        .limit(query.limit + 1);
      const page = toPage(rows, query.limit);
      return { items: page.items.map(toView), nextCursor: page.nextCursor };
    });
  }

  /** Marca na blacklist. O bot passa a ignorar os lances dessa pessoa (e `place_bid` já os recusa). */
  async blacklist(context: Context, id: string, reason: string | null): Promise<CustomerResult> {
    return this.setBlacklist(context, id, true, reason);
  }

  async unblacklist(context: Context, id: string): Promise<CustomerResult> {
    return this.setBlacklist(context, id, false, null);
  }

  private async setBlacklist(
    context: Context,
    id: string,
    flag: boolean,
    reason: string | null,
  ): Promise<CustomerResult> {
    return withContext(this.db, context, async (tx) => {
      const [updated] = await tx
        .update(customers)
        .set({ isBlacklisted: flag, blacklistReason: flag ? reason : null, updatedAt: new Date() })
        .where(and(eq(customers.id, id), eq(customers.storeId, context.storeId)))
        .returning();
      if (updated === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: flag ? 'customer.blacklisted' : 'customer.unblacklisted',
        targetType: 'customer',
        targetId: id,
      });
      return { ok: true, customer: toView(updated) } as const;
    });
  }

  /** Acertos do cliente (aba "Acerto"). */
  async settlementsOf(
    context: Context,
    id: string,
    query: { limit: number; cursor?: string; status?: 'PENDING' | 'PAID' },
  ): Promise<Page<SettlementView> | 'INVALID_CURSOR' | null> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    return withContext(this.db, context, async (tx) => {
      if (!(await this.exists(tx, context.storeId, id))) return null;
      const rows = await tx
        .select({
          row: settlements,
          items: sql<string>`(SELECT count(*) FROM settlement_items si WHERE si.settlement_id = settlements.id)`,
        })
        .from(settlements)
        .where(
          and(
            eq(settlements.storeId, context.storeId),
            eq(settlements.customerId, id),
            query.status === undefined ? undefined : eq(settlements.status, query.status),
            position === null
              ? undefined
              : sql`(${settlements.createdAt}, ${settlements.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(settlements.createdAt), desc(settlements.id))
        .limit(query.limit + 1);
      const page = toPage(
        rows.map(({ row, items }) => ({
          id: row.id,
          status: row.status,
          totalAmount: row.totalAmount,
          items: Number(items),
          paidAt: row.paidAt,
          createdAt: row.createdAt,
        })),
        query.limit,
      );
      return page;
    });
  }

  private async exists(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    storeId: string,
    id: string,
  ) {
    const [row] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, id), eq(customers.storeId, storeId)))
      .limit(1);
    return row !== undefined;
  }

  /** Lances do cliente (aba "Histórico"), do mais novo para o mais antigo. */
  async bidsOf(
    context: Context,
    id: string,
    query: { limit: number; cursor?: string },
  ): Promise<Page<BidHistoryItem> | 'INVALID_CURSOR' | null> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    return withContext(this.db, context, async (tx) => {
      if (!(await this.exists(tx, context.storeId, id))) return null;
      const rows = await tx
        .select({
          bid: bids,
          auctionStatus: auctions.status,
          winningBidId: auctions.winningBidId,
          cardId: cardsInventory.id,
          shortCode: cardsInventory.shortCode,
          name: sql<string>`(SELECT name FROM tcgdex_catalog WHERE id = ${cardsInventory.tcgdexId})`,
        })
        .from(bids)
        .innerJoin(
          auctions,
          and(eq(auctions.id, bids.auctionId), eq(auctions.storeId, context.storeId)),
        )
        .innerJoin(
          cardsInventory,
          and(eq(cardsInventory.id, auctions.cardId), eq(cardsInventory.storeId, context.storeId)),
        )
        .where(
          and(
            eq(bids.storeId, context.storeId),
            eq(bids.customerId, id),
            position === null
              ? undefined
              : sql`(${bids.createdAt}, ${bids.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(bids.createdAt), desc(bids.id))
        .limit(query.limit + 1);
      return toPage(
        rows.map((r) => ({
          id: r.bid.id,
          amount: r.bid.amount,
          createdAt: r.bid.createdAt,
          auctionId: r.bid.auctionId,
          auctionStatus: r.auctionStatus,
          won: r.winningBidId === r.bid.id,
          card: { id: r.cardId, shortCode: r.shortCode, name: r.name },
        })),
        query.limit,
      );
    });
  }

  /**
   * Carteira de consignação: as cartas do cliente, o que já vendeu e o que tem a receber.
   * Líquido = lance vencedor menos a comissão da loja. Valores são **estimativas** até o acerto.
   */
  async consignmentsOf(
    context: Context,
    id: string,
    query: { limit: number; cursor?: string },
  ): Promise<ConsignmentWallet | 'INVALID_CURSOR' | null> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    return withContext(this.db, context, async (tx) => {
      if (!(await this.exists(tx, context.storeId, id))) return null;
      const cursor =
        position === null
          ? sql``
          : sql`AND (c.created_at, c.id) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`;
      const result = await tx.execute<{
        id: string;
        created_at: Date;
        short_code: string;
        name: string;
        card_status: string;
        pct: string;
        sale: string | null;
        commission: string | null;
        net: string | null;
      }>(sql`
        SELECT c.id, c.created_at, c.short_code, t.name, c.status AS card_status,
               c.store_commission_pct AS pct, w.amount AS sale,
               round(w.amount * c.store_commission_pct / 100, 2) AS commission,
               w.amount - round(w.amount * c.store_commission_pct / 100, 2) AS net
          FROM cards_inventory c
          JOIN tcgdex_catalog t ON t.id = c.tcgdex_id
          LEFT JOIN LATERAL (
            SELECT b.amount
              FROM auctions a JOIN bids b ON b.id = a.winning_bid_id AND b.store_id = a.store_id
             WHERE a.card_id = c.id AND a.store_id = c.store_id AND a.status = 'FINISHED'
             ORDER BY a.end_time DESC LIMIT 1
          ) w ON c.status IN ('AWAITING_CONFIRMATION', 'SOLD')
         WHERE c.store_id = ${context.storeId}::uuid AND c.consignor_id = ${id}::uuid ${cursor}
         ORDER BY c.created_at DESC, c.id DESC
         LIMIT ${query.limit + 1}
      `);
      const page = toPage(
        result.rows.map((r) => ({
          id: r.id,
          createdAt: new Date(r.created_at),
          shortCode: r.short_code,
          name: r.name,
          cardStatus: r.card_status,
          commissionPct: r.pct,
          saleAmount: r.sale,
          commissionAmount: r.commission,
          netAmount: r.net,
        })),
        query.limit,
      );

      const totals = await tx.execute<{
        in_stock: string;
        pending_net: string;
        sold_net: string;
        commission: string;
      }>(sql`
        SELECT count(*) FILTER (WHERE c.status IN ('AVAILABLE', 'SCHEDULED')) AS in_stock,
               coalesce(sum(w.amount - round(w.amount * c.store_commission_pct / 100, 2))
                        FILTER (WHERE c.status = 'AWAITING_CONFIRMATION'), 0)::numeric(12, 2) AS pending_net,
               coalesce(sum(w.amount - round(w.amount * c.store_commission_pct / 100, 2))
                        FILTER (WHERE c.status = 'SOLD'), 0)::numeric(12, 2) AS sold_net,
               coalesce(sum(round(w.amount * c.store_commission_pct / 100, 2))
                        FILTER (WHERE c.status IN ('AWAITING_CONFIRMATION', 'SOLD')), 0)::numeric(12, 2) AS commission
          FROM cards_inventory c
          LEFT JOIN LATERAL (
            SELECT b.amount
              FROM auctions a JOIN bids b ON b.id = a.winning_bid_id AND b.store_id = a.store_id
             WHERE a.card_id = c.id AND a.store_id = c.store_id AND a.status = 'FINISHED'
             ORDER BY a.end_time DESC LIMIT 1
          ) w ON true
         WHERE c.store_id = ${context.storeId}::uuid AND c.consignor_id = ${id}::uuid
      `);
      const sums = totals.rows[0];
      return {
        items: page,
        totals: {
          inStock: Number(sums?.in_stock ?? 0),
          pendingNet: sums?.pending_net ?? '0.00',
          soldNet: sums?.sold_net ?? '0.00',
          commission: sums?.commission ?? '0.00',
        },
      };
    });
  }
}
