import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import type { DashboardService, Period } from '../dashboard/service.js';
import { problemSchema } from '../http/problem.js';
import { storeHeader } from './store.js';

export interface DashboardRouteDeps {
  hooks: AuthHooks;
  dashboard: DashboardService;
}

const security = [{ bearerAuth: [] }];
const PERIODS = ['today', '7', '15', '30'] as const;

const failures = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
} as const;

const periodQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    period: { type: 'string', enum: PERIODS, default: '7', description: 'Hoje, 7, 15 ou 30 dias' },
  },
} as const;

const sliceSchema = {
  type: 'array',
  items: {
    type: 'object',
    required: ['key', 'revenue', 'count'],
    properties: {
      key: { type: 'string' },
      revenue: { type: 'string' },
      count: { type: 'integer' },
    },
  },
} as const;

export function dashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
  const { hooks, dashboard } = deps;
  const member = [hooks.authenticate, hooks.requireStore];
  const finance = [...member, hooks.requirePermission('can_view_finance')];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };

  const periodOf = (request: { query: unknown }): Period =>
    (request.query as { period?: Period }).period ?? '7';

  app.get(
    '/v1/dashboard/home',
    {
      preValidation: member,
      schema: {
        operationId: 'getHomeDashboard',
        tags: ['dashboard'],
        summary:
          'Home ao vivo: alerta de enquetes, 5 KPIs, lembrete de cartas sem leilão e acertos rápidos',
        description:
          'Sem período e sem rankings: cada chamada devolve o agora. O front consulta de tempos em tempos.',
        security,
        headers: storeHeader,
        response: {
          200: {
            type: 'object',
            required: [
              'setup',
              'poll_alerts',
              'kpis',
              'cards_without_auction',
              'quick_settlements',
            ],
            properties: {
              setup: {
                type: 'object',
                required: ['store_created', 'whatsapp_connected', 'first_card', 'first_auction'],
                properties: {
                  store_created: { type: 'boolean' },
                  whatsapp_connected: { type: 'boolean' },
                  first_card: { type: 'boolean' },
                  first_auction: { type: 'boolean' },
                },
              },
              poll_alerts: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['auction_id', 'card', 'ceiling', 'current_bid', 'provisional_winner'],
                  properties: {
                    auction_id: { type: 'string', format: 'uuid' },
                    card: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        short_code: { type: 'string' },
                        name: { type: 'string' },
                      },
                    },
                    ceiling: { type: 'string' },
                    current_bid: { type: 'string' },
                    provisional_winner: {
                      type: 'object',
                      nullable: true,
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                      },
                    },
                  },
                },
              },
              kpis: {
                type: 'object',
                required: [
                  'active_auctions',
                  'scheduled_today',
                  'bids_in_active',
                  'pending_settlements',
                  'cards_without_auction',
                ],
                properties: {
                  active_auctions: { type: 'integer' },
                  scheduled_today: { type: 'integer' },
                  bids_in_active: { type: 'integer' },
                  pending_settlements: { type: 'integer' },
                  cards_without_auction: { type: 'integer' },
                },
              },
              cards_without_auction: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    short_code: { type: 'string' },
                    name: { type: 'string' },
                  },
                },
              },
              quick_settlements: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    customer: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                      },
                    },
                    total_amount: { type: 'string' },
                    items: { type: 'integer' },
                    created_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
          ...failures,
        },
      },
    },
    async (request) => {
      const home = await dashboard.home(contextOf(request));
      return {
        setup: {
          store_created: home.setup.storeCreated,
          whatsapp_connected: home.setup.whatsappConnected,
          first_card: home.setup.firstCard,
          first_auction: home.setup.firstAuction,
        },
        poll_alerts: home.pollAlerts.map((a) => ({
          auction_id: a.auctionId,
          card: { id: a.card.id, short_code: a.card.shortCode, name: a.card.name },
          ceiling: a.ceiling,
          current_bid: a.currentBid,
          provisional_winner: a.provisionalWinner,
        })),
        kpis: {
          active_auctions: home.kpis.activeAuctions,
          scheduled_today: home.kpis.scheduledToday,
          bids_in_active: home.kpis.bidsInActive,
          pending_settlements: home.kpis.pendingSettlements,
          cards_without_auction: home.kpis.cardsWithoutAuction,
        },
        cards_without_auction: home.cardsWithoutAuction.map((c) => ({
          id: c.id,
          short_code: c.shortCode,
          name: c.name,
        })),
        quick_settlements: home.quickSettlements.map((s) => ({
          id: s.id,
          customer: s.customer,
          total_amount: s.totalAmount,
          items: s.items,
          created_at: s.createdAt.toISOString(),
        })),
      };
    },
  );

  app.get(
    '/v1/finance/overview',
    {
      preValidation: finance,
      schema: {
        operationId: 'getFinanceOverview',
        tags: ['dashboard'],
        summary:
          'Financeiro: KPIs, séries diárias, histogramas e pizzas (único com filtro de período)',
        description:
          'Só vendas pagas. Receita = valor dos itens (sem o frete). Lucro = valor todo nas cartas próprias (ainda não há custo de compra) e só a comissão nas consignadas. Dias no fuso de São Paulo.',
        security,
        headers: storeHeader,
        querystring: periodQuery,
        response: {
          200: {
            type: 'object',
            required: [
              'period',
              'from',
              'kpis',
              'daily',
              'sales_by_price',
              'bids_by_hour',
              'by_origin',
              'by_language',
              'by_condition',
            ],
            properties: {
              period: { type: 'string', enum: PERIODS },
              from: { type: 'string' },
              kpis: {
                type: 'object',
                required: ['revenue', 'profit', 'items_sold', 'average_item'],
                properties: {
                  revenue: { type: 'string' },
                  profit: { type: 'string' },
                  items_sold: { type: 'integer' },
                  average_item: { type: 'string' },
                },
              },
              daily: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    day: { type: 'string' },
                    revenue: { type: 'string' },
                    profit: { type: 'string' },
                  },
                },
              },
              sales_by_price: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { band: { type: 'string' }, count: { type: 'integer' } },
                },
              },
              bids_by_hour: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { hour: { type: 'integer' }, count: { type: 'integer' } },
                },
              },
              by_origin: sliceSchema,
              by_language: sliceSchema,
              by_condition: sliceSchema,
            },
          },
          ...failures,
        },
      },
    },
    async (request) => {
      const o = await dashboard.financeOverview(contextOf(request), periodOf(request));
      return {
        period: o.period,
        from: o.from,
        kpis: {
          revenue: o.kpis.revenue,
          profit: o.kpis.profit,
          items_sold: o.kpis.itemsSold,
          average_item: o.kpis.averageItem,
        },
        daily: o.daily,
        sales_by_price: o.salesByPrice,
        bids_by_hour: o.bidsByHour,
        by_origin: o.byOrigin,
        by_language: o.byLanguage,
        by_condition: o.byCondition,
      };
    },
  );

  app.get(
    '/v1/finance/top-buyers',
    {
      preValidation: finance,
      schema: {
        operationId: 'getTopBuyers',
        tags: ['dashboard'],
        summary: 'Top compradores do período (vendas pagas)',
        security,
        headers: storeHeader,
        querystring: {
          ...periodQuery,
          properties: {
            ...periodQuery.properties,
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    customer: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                      },
                    },
                    purchases: { type: 'integer' },
                    total: { type: 'string' },
                  },
                },
              },
            },
          },
          ...failures,
        },
      },
    },
    async (request) => {
      const { limit } = request.query as { limit?: number };
      const items = await dashboard.topBuyers(contextOf(request), periodOf(request), limit ?? 10);
      return { items };
    },
  );

  app.get(
    '/v1/finance/consignment-payouts',
    {
      preValidation: finance,
      schema: {
        operationId: 'getConsignmentPayouts',
        tags: ['dashboard'],
        summary: 'Repasses de consignação do período: o que cada consignador tem a receber',
        description: 'Repasse = valor da venda paga menos a comissão da loja.',
        security,
        headers: storeHeader,
        querystring: periodQuery,
        response: {
          200: {
            type: 'object',
            required: ['items'],
            properties: {
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    consignor: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                      },
                    },
                    items_sold: { type: 'integer' },
                    gross: { type: 'string' },
                    commission: { type: 'string' },
                    payout: { type: 'string' },
                  },
                },
              },
            },
          },
          ...failures,
        },
      },
    },
    async (request) => {
      const items = await dashboard.consignmentPayouts(contextOf(request), periodOf(request));
      return {
        items: items.map((i) => ({
          consignor: i.consignor,
          items_sold: i.itemsSold,
          gross: i.gross,
          commission: i.commission,
          payout: i.payout,
        })),
      };
    },
  );
}
