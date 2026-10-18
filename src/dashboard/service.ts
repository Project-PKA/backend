import { sql } from 'drizzle-orm';

import { withContext, type Db, type Tx } from '../db/context.js';

interface Context {
  storeId: string;
  userId: string;
}

/** Fuso usado para "hoje" e para agrupar por dia e por hora (ainda não há fuso por loja). */
export const DASHBOARD_TZ = 'America/Sao_Paulo';

export type Period = 'today' | '7' | '15' | '30';
export const PERIOD_DAYS: Record<Period, number> = { today: 1, '7': 7, '15': 15, '30': 30 };

export interface PollAlert {
  auctionId: string;
  card: { id: string; shortCode: string; name: string };
  ceiling: string;
  currentBid: string;
  provisionalWinner: { id: string; name: string } | null;
}

export interface HomeView {
  setup: {
    storeCreated: true;
    whatsappConnected: boolean;
    firstCard: boolean;
    firstAuction: boolean;
  };
  pollAlerts: PollAlert[];
  kpis: {
    activeAuctions: number;
    scheduledToday: number;
    bidsInActive: number;
    pendingSettlements: number;
    cardsWithoutAuction: number;
  };
  cardsWithoutAuction: { id: string; shortCode: string; name: string }[];
  quickSettlements: {
    id: string;
    customer: { id: string; name: string };
    totalAmount: string;
    items: number;
    createdAt: Date;
  }[];
}

export interface FinanceOverview {
  period: Period;
  from: string;
  kpis: { revenue: string; profit: string; itemsSold: number; averageItem: string };
  daily: { day: string; revenue: string; profit: string }[];
  salesByPrice: { band: string; count: number }[];
  bidsByHour: { hour: number; count: number }[];
  byOrigin: Slice[];
  byLanguage: Slice[];
  byCondition: Slice[];
}

export interface Slice {
  key: string;
  revenue: string;
  count: number;
}

export interface TopBuyer {
  customer: { id: string; name: string };
  purchases: number;
  total: string;
}

export interface ConsignmentPayout {
  consignor: { id: string; name: string };
  itemsSold: number;
  gross: string;
  commission: string;
  payout: string;
}

const PRICE_BANDS = [
  { band: 'UP_TO_25', low: 0, high: 25 },
  { band: '25_TO_50', low: 25, high: 50 },
  { band: '50_TO_100', low: 50, high: 100 },
  { band: '100_TO_200', low: 100, high: 200 },
  { band: 'OVER_200', low: 200, high: null },
] as const;

/** Início do primeiro dia do período, no fuso do painel (`today` = hoje desde 00:00). */
const fromExpr = (days: number) =>
  sql`((date_trunc('day', now() AT TIME ZONE ${DASHBOARD_TZ}::text) - make_interval(days => ${days - 1}))
        AT TIME ZONE ${DASHBOARD_TZ}::text)`;

/**
 * Vendas pagas do período: um item por linha, com o lucro da loja. Lucro = o valor todo nas cartas
 * próprias (ainda não há custo de compra) e só a comissão nas consignadas.
 */
const salesCte = (storeId: string, days: number) => sql`
  sales AS (
    SELECT si.amount, s.paid_at, s.customer_id, c.ownership_type, c.language, c.condition,
           c.consignor_id, c.store_commission_pct,
           (s.paid_at AT TIME ZONE ${DASHBOARD_TZ}::text)::date AS day,
           CASE WHEN c.ownership_type = 'CONSIGNED'
                THEN round(si.amount * c.store_commission_pct / 100, 2) ELSE si.amount END AS profit
      FROM settlements s
      JOIN settlement_items si ON si.settlement_id = s.id AND si.store_id = s.store_id
      JOIN cards_inventory c ON c.id = si.card_id AND c.store_id = si.store_id
     WHERE s.store_id = ${storeId}::uuid AND s.status = 'PAID' AND s.paid_at >= ${fromExpr(days)}
  )`;

const money = (value: string | null | undefined): string => value ?? '0.00';

/** Painéis da loja: Home ao vivo (sem período) e Financeiro (único com período). */
export class DashboardService {
  constructor(private readonly db: Db) {}

  private async advance(tx: Tx, storeId: string): Promise<void> {
    await tx.execute(sql`SELECT * FROM advance_auctions(${storeId}::uuid)`);
  }

  async home(context: Context): Promise<HomeView> {
    const storeId = context.storeId;
    return withContext(this.db, context, async (tx) => {
      await this.advance(tx, storeId);

      const kpis = await tx.execute<{
        active: string;
        scheduled_today: string;
        bids_active: string;
        pending: string;
        without_auction: string;
        total_cards: string;
        total_auctions: string;
        whatsapp_online: boolean;
        group_set: boolean;
      }>(sql`
        SELECT
          (SELECT count(*) FROM auctions WHERE store_id = ${storeId}::uuid AND status = 'ACTIVE') AS active,
          (SELECT count(*) FROM auctions WHERE store_id = ${storeId}::uuid AND status = 'PENDING'
              AND (start_time AT TIME ZONE ${DASHBOARD_TZ}::text)::date
                  = (now() AT TIME ZONE ${DASHBOARD_TZ}::text)::date) AS scheduled_today,
          (SELECT count(*) FROM bids b JOIN auctions a ON a.id = b.auction_id AND a.store_id = b.store_id
            WHERE b.store_id = ${storeId}::uuid
              AND a.status IN ('ACTIVE', 'PAUSED_FOR_VALIDATION')) AS bids_active,
          (SELECT count(*) FROM settlements WHERE store_id = ${storeId}::uuid AND status = 'PENDING') AS pending,
          (SELECT count(*) FROM cards_inventory c WHERE c.store_id = ${storeId}::uuid AND c.status = 'AVAILABLE'
              AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.card_id = c.id)) AS without_auction,
          (SELECT count(*) FROM cards_inventory WHERE store_id = ${storeId}::uuid) AS total_cards,
          (SELECT count(*) FROM auctions WHERE store_id = ${storeId}::uuid) AS total_auctions,
          (SELECT whatsapp_status = 'ONLINE' FROM stores WHERE id = ${storeId}::uuid) AS whatsapp_online,
          (SELECT whatsapp_group_id IS NOT NULL FROM stores WHERE id = ${storeId}::uuid) AS group_set
      `);
      const k = kpis.rows[0];

      const alerts = await tx.execute<{
        auction_id: string;
        ceiling: string;
        current_bid: string;
        card_id: string;
        short_code: string;
        name: string;
        leader_id: string | null;
        leader_name: string | null;
      }>(sql`
        SELECT a.id AS auction_id, a.max_poll_value::numeric(12, 2)::text AS ceiling,
               top.amount::numeric(12, 2)::text AS current_bid, c.id AS card_id, c.short_code, t.name,
               top.customer_id AS leader_id, cu.name AS leader_name
          FROM auctions a
          JOIN cards_inventory c ON c.id = a.card_id AND c.store_id = a.store_id
          JOIN tcgdex_catalog t ON t.id = c.tcgdex_id
          LEFT JOIN LATERAL (
            SELECT b.amount, b.customer_id FROM bids b
             WHERE b.auction_id = a.id AND b.store_id = a.store_id
             ORDER BY b.amount DESC LIMIT 1) top ON true
          LEFT JOIN customers cu ON cu.id = top.customer_id AND cu.store_id = a.store_id
         WHERE a.store_id = ${storeId}::uuid AND a.status = 'PAUSED_FOR_VALIDATION'
         ORDER BY a.end_time, a.id
      `);

      const reminder = await tx.execute<{ id: string; short_code: string; name: string }>(sql`
        SELECT c.id, c.short_code, t.name
          FROM cards_inventory c JOIN tcgdex_catalog t ON t.id = c.tcgdex_id
         WHERE c.store_id = ${storeId}::uuid AND c.status = 'AVAILABLE'
           AND NOT EXISTS (SELECT 1 FROM auctions a WHERE a.card_id = c.id)
         ORDER BY c.created_at DESC, c.id DESC LIMIT 5
      `);

      const quick = await tx.execute<{
        id: string;
        total: string;
        items: string;
        created_at: Date;
        customer_id: string;
        customer_name: string;
      }>(sql`
        SELECT s.id, s.total_amount::numeric(12, 2)::text AS total, s.created_at,
               cu.id AS customer_id, cu.name AS customer_name,
               (SELECT count(*) FROM settlement_items si WHERE si.settlement_id = s.id) AS items
          FROM settlements s JOIN customers cu ON cu.id = s.customer_id AND cu.store_id = s.store_id
         WHERE s.store_id = ${storeId}::uuid AND s.status = 'PENDING'
         ORDER BY s.created_at, s.id LIMIT 5
      `);

      return {
        setup: {
          storeCreated: true,
          whatsappConnected: (k?.whatsapp_online ?? false) && (k?.group_set ?? false),
          firstCard: Number(k?.total_cards ?? 0) > 0,
          firstAuction: Number(k?.total_auctions ?? 0) > 0,
        },
        pollAlerts: alerts.rows.map((r) => ({
          auctionId: r.auction_id,
          card: { id: r.card_id, shortCode: r.short_code, name: r.name },
          ceiling: r.ceiling,
          currentBid: money(r.current_bid),
          provisionalWinner:
            r.leader_id === null ? null : { id: r.leader_id, name: r.leader_name ?? '' },
        })),
        kpis: {
          activeAuctions: Number(k?.active ?? 0),
          scheduledToday: Number(k?.scheduled_today ?? 0),
          bidsInActive: Number(k?.bids_active ?? 0),
          pendingSettlements: Number(k?.pending ?? 0),
          cardsWithoutAuction: Number(k?.without_auction ?? 0),
        },
        cardsWithoutAuction: reminder.rows.map((r) => ({
          id: r.id,
          shortCode: r.short_code,
          name: r.name,
        })),
        quickSettlements: quick.rows.map((r) => ({
          id: r.id,
          customer: { id: r.customer_id, name: r.customer_name },
          totalAmount: r.total,
          items: Number(r.items),
          createdAt: new Date(r.created_at),
        })),
      };
    });
  }

  async financeOverview(context: Context, period: Period): Promise<FinanceOverview> {
    const days = PERIOD_DAYS[period];
    const storeId = context.storeId;
    return withContext(this.db, context, async (tx) => {
      const kpis = await tx.execute<{
        revenue: string;
        profit: string;
        items: string;
        average: string;
        from_day: string;
      }>(sql`
        WITH ${salesCte(storeId, days)}
        SELECT coalesce(sum(amount), 0)::numeric(12, 2)::text AS revenue,
               coalesce(sum(profit), 0)::numeric(12, 2)::text AS profit,
               count(*)::text AS items,
               coalesce(round(avg(amount), 2), 0)::numeric(12, 2)::text AS average,
               (${fromExpr(days)} AT TIME ZONE ${DASHBOARD_TZ}::text)::date::text AS from_day
          FROM sales
      `);

      const daily = await tx.execute<{ day: string; revenue: string; profit: string }>(sql`
        WITH ${salesCte(storeId, days)},
        span AS (
          SELECT generate_series(
                   (${fromExpr(days)} AT TIME ZONE ${DASHBOARD_TZ}::text)::date,
                   (now() AT TIME ZONE ${DASHBOARD_TZ}::text)::date, interval '1 day')::date AS day
        )
        SELECT span.day::text AS day,
               coalesce(sum(sales.amount), 0)::numeric(12, 2)::text AS revenue,
               coalesce(sum(sales.profit), 0)::numeric(12, 2)::text AS profit
          FROM span LEFT JOIN sales ON sales.day = span.day
         GROUP BY span.day ORDER BY span.day
      `);

      const prices = await tx.execute<{ amount: string }>(sql`
        WITH ${salesCte(storeId, days)} SELECT amount::text FROM sales
      `);
      const salesByPrice = PRICE_BANDS.map((band) => ({
        band: band.band,
        count: prices.rows.filter((row) => {
          const value = Number(row.amount);
          return value >= band.low && (band.high === null || value < band.high);
        }).length,
      }));

      const hours = await tx.execute<{ hour: number; count: string }>(sql`
        SELECT extract(hour FROM b.created_at AT TIME ZONE ${DASHBOARD_TZ}::text)::int AS hour,
               count(*)::text AS count
          FROM bids b
         WHERE b.store_id = ${storeId}::uuid AND b.created_at >= ${fromExpr(days)}
         GROUP BY 1
      `);
      const byHour = new Map(hours.rows.map((r) => [r.hour, Number(r.count)]));

      const slices = async (
        column: 'ownership_type' | 'language' | 'condition',
      ): Promise<Slice[]> => {
        const rows = await tx.execute<{ key: string; revenue: string; count: string }>(sql`
          WITH ${salesCte(storeId, days)}
          SELECT ${sql.raw(column)}::text AS key,
                 sum(amount)::numeric(12, 2)::text AS revenue, count(*)::text AS count
            FROM sales GROUP BY 1 ORDER BY sum(amount) DESC, 1
        `);
        return rows.rows.map((r) => ({ key: r.key, revenue: r.revenue, count: Number(r.count) }));
      };

      const k = kpis.rows[0];
      return {
        period,
        from: k?.from_day ?? '',
        kpis: {
          revenue: money(k?.revenue),
          profit: money(k?.profit),
          itemsSold: Number(k?.items ?? 0),
          averageItem: money(k?.average),
        },
        daily: daily.rows,
        salesByPrice,
        bidsByHour: Array.from({ length: 24 }, (_, hour) => ({
          hour,
          count: byHour.get(hour) ?? 0,
        })),
        byOrigin: await slices('ownership_type'),
        byLanguage: await slices('language'),
        byCondition: await slices('condition'),
      };
    });
  }

  async topBuyers(context: Context, period: Period, limit: number): Promise<TopBuyer[]> {
    const storeId = context.storeId;
    return withContext(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        name: string;
        purchases: string;
        total: string;
      }>(sql`
        WITH ${salesCte(storeId, PERIOD_DAYS[period])}
        SELECT cu.id, cu.name, count(*)::text AS purchases, sum(sales.amount)::numeric(12, 2)::text AS total
          FROM sales JOIN customers cu ON cu.id = sales.customer_id AND cu.store_id = ${storeId}::uuid
         GROUP BY cu.id, cu.name
         ORDER BY sum(sales.amount) DESC, cu.name, cu.id
         LIMIT ${limit}
      `);
      return rows.rows.map((r) => ({
        customer: { id: r.id, name: r.name },
        purchases: Number(r.purchases),
        total: r.total,
      }));
    });
  }

  /** Repasses de consignação do período: o que cada consignador tem a receber das vendas pagas. */
  async consignmentPayouts(context: Context, period: Period): Promise<ConsignmentPayout[]> {
    const storeId = context.storeId;
    return withContext(this.db, context, async (tx) => {
      const rows = await tx.execute<{
        id: string;
        name: string;
        items: string;
        gross: string;
        commission: string;
        payout: string;
      }>(sql`
        WITH ${salesCte(storeId, PERIOD_DAYS[period])}
        SELECT cu.id, cu.name, count(*)::text AS items,
               sum(sales.amount)::numeric(12, 2)::text AS gross,
               sum(sales.profit)::numeric(12, 2)::text AS commission,
               sum(sales.amount - sales.profit)::numeric(12, 2)::text AS payout
          FROM sales JOIN customers cu ON cu.id = sales.consignor_id AND cu.store_id = ${storeId}::uuid
         WHERE sales.ownership_type = 'CONSIGNED'
         GROUP BY cu.id, cu.name
         ORDER BY sum(sales.amount - sales.profit) DESC, cu.name, cu.id
      `);
      return rows.rows.map((r) => ({
        consignor: { id: r.id, name: r.name },
        itemsSold: Number(r.items),
        gross: r.gross,
        commission: r.commission,
        payout: r.payout,
      }));
    });
  }
}
