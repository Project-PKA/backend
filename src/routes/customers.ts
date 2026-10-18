import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import type {
  BidHistoryItem,
  ConsignmentItem,
  CustomerFailure,
  CustomerInput,
  CustomerService,
  CustomerView,
  SettlementView,
} from '../customers/service.js';
import { DEFAULT_LIMIT, pageQuerySchema } from '../http/pagination.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import { storeHeader } from './store.js';

export interface CustomerRouteDeps {
  hooks: AuthHooks;
  customers: CustomerService;
}

const security = [{ bearerAuth: [] }];

const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const addressInput = {
  type: 'object',
  additionalProperties: false,
  properties: {
    zip: { type: 'string', maxLength: 9, nullable: true },
    street: { type: 'string', maxLength: 120, nullable: true },
    number: { type: 'string', maxLength: 20, nullable: true },
    comp: { type: 'string', maxLength: 60, nullable: true },
    city: { type: 'string', maxLength: 80, nullable: true },
    state: { type: 'string', pattern: '^[A-Za-z]{2}$', nullable: true },
  },
} as const;

const editable = {
  name: { type: 'string', minLength: 1, maxLength: 120 },
  email: { type: 'string', format: 'email', maxLength: 254, nullable: true },
  cpf: {
    type: 'string',
    maxLength: 14,
    nullable: true,
    description: 'Validado; nunca devolvido inteiro',
  },
  address: addressInput,
} as const;

const customerResponse = {
  type: 'object',
  required: [
    'id',
    'phone',
    'name',
    'email',
    'cpf_masked',
    'kind',
    'is_blacklisted',
    'blacklist_reason',
    'last_interaction_at',
    'address',
    'created_at',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    phone: { type: 'string', description: 'Só dígitos, com código do país' },
    name: { type: 'string' },
    email: { type: 'string', nullable: true },
    cpf_masked: { type: 'string', nullable: true },
    kind: { type: 'string', enum: ['VISITOR', 'CUSTOMER'] },
    is_blacklisted: { type: 'boolean' },
    blacklist_reason: { type: 'string', nullable: true },
    last_interaction_at: { type: 'string', format: 'date-time', nullable: true },
    address: {
      type: 'object',
      properties: {
        zip: { type: 'string', nullable: true },
        street: { type: 'string', nullable: true },
        number: { type: 'string', nullable: true },
        comp: { type: 'string', nullable: true },
        city: { type: 'string', nullable: true },
        state: { type: 'string', nullable: true },
      },
    },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const pageOf = (item: object) =>
  ({
    type: 'object',
    required: ['items', 'next_cursor'],
    properties: {
      items: { type: 'array', items: item },
      next_cursor: { type: 'string', nullable: true },
    },
  }) as const;

const toCustomerJson = (view: CustomerView) => ({
  id: view.id,
  phone: view.phone,
  name: view.name,
  email: view.email,
  cpf_masked: view.cpfMasked,
  kind: view.kind,
  is_blacklisted: view.isBlacklisted,
  blacklist_reason: view.blacklistReason,
  last_interaction_at: view.lastInteractionAt?.toISOString() ?? null,
  address: view.address,
  created_at: view.createdAt.toISOString(),
});

const FAILURES: Record<CustomerFailure, [number, string]> = {
  NOT_FOUND: [404, 'Cliente não encontrado'],
  PHONE_INVALID: [422, 'Telefone inválido: informe com DDD (e código do país, se for de fora)'],
  PHONE_TAKEN: [409, 'Já existe um cliente com este telefone nesta loja'],
  CPF_INVALID: [422, 'CPF inválido'],
  CEP_INVALID: [422, 'CEP inválido'],
  INACTIVITY_NOT_SET: [409, 'Defina o limite de dias de inatividade da loja primeiro'],
};

const sendFailure = (reply: FastifyReply, reason: CustomerFailure) => {
  const [status, detail] = FAILURES[reason];
  return sendProblem(reply, buildProblem(status, detail, `CUSTOMER_${reason}`));
};

const invalidCursor = (reply: FastifyReply) =>
  sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));

const failures = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
} as const;

function toInput(body: Record<string, unknown>): CustomerInput {
  const address = body['address'] as CustomerInput['address'];
  return {
    ...(body['phone'] === undefined ? {} : { phone: body['phone'] as string }),
    ...(body['name'] === undefined ? {} : { name: body['name'] as string }),
    ...(body['email'] === undefined ? {} : { email: body['email'] as string | null }),
    ...(body['cpf'] === undefined ? {} : { cpf: body['cpf'] as string | null }),
    ...(address === undefined ? {} : { address }),
  };
}

export function customerRoutes(app: FastifyInstance, deps: CustomerRouteDeps): void {
  const { hooks, customers } = deps;
  const member = [hooks.authenticate, hooks.requireStore];
  const manage = [...member, hooks.requirePermission('can_manage_customers')];
  const finance = [...member, hooks.requirePermission('can_view_finance')];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };

  const pageOptions = (request: { query: unknown }) => {
    const q = request.query as { cursor?: string; limit?: number };
    return {
      limit: q.limit ?? DEFAULT_LIMIT,
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
    };
  };

  app.post(
    '/v1/customers',
    {
      preValidation: manage,
      schema: {
        operationId: 'createCustomer',
        tags: ['customers'],
        summary: 'Cadastra um cliente ou visitante (o telefone é único por loja)',
        description:
          'Com CPF e endereço completos é Cliente; sem eles, Visitante. Telefone, CPF e CEP são validados e guardados só com dígitos.',
        security,
        headers: storeHeader,
        body: {
          type: 'object',
          required: ['phone', 'name'],
          additionalProperties: false,
          properties: { phone: { type: 'string', minLength: 8, maxLength: 20 }, ...editable },
        },
        response: { 201: customerResponse, ...failures },
      },
    },
    async (request, reply) => {
      const input = toInput(request.body as Record<string, unknown>);
      const result = await customers.create(contextOf(request), {
        ...input,
        phone: input.phone ?? '',
        name: input.name ?? '',
      });
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.status(201).send(toCustomerJson(result.customer));
    },
  );

  app.get(
    '/v1/customers',
    {
      preValidation: member,
      schema: {
        operationId: 'listCustomers',
        tags: ['customers'],
        summary: 'Base de clientes e visitantes, com filtros',
        security,
        headers: storeHeader,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            q: { type: 'string', maxLength: 80, description: 'Nome ou telefone' },
            kind: { type: 'string', enum: ['VISITOR', 'CUSTOMER'] },
            blacklisted: { type: 'boolean' },
            inactive: {
              type: 'boolean',
              description: 'Sem interação há mais dias que o limite de inatividade da loja',
            },
            consignor: { type: 'boolean', description: 'Só quem tem carta consignada' },
          },
        },
        response: { 200: pageOf(customerResponse), ...failures },
      },
    },
    async (request, reply) => {
      const q = request.query as Record<string, unknown>;
      const result = await customers.list(contextOf(request), {
        ...pageOptions(request),
        ...(q['q'] === undefined ? {} : { q: q['q'] as string }),
        ...(q['kind'] === undefined ? {} : { kind: q['kind'] as 'VISITOR' | 'CUSTOMER' }),
        ...(q['blacklisted'] === undefined ? {} : { blacklisted: q['blacklisted'] as boolean }),
        ...(q['inactive'] === undefined ? {} : { inactive: q['inactive'] as boolean }),
        ...(q['consignor'] === undefined ? {} : { consignor: q['consignor'] as boolean }),
      });
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      if (result === 'INACTIVITY_NOT_SET') return sendFailure(reply, 'INACTIVITY_NOT_SET');
      return { items: result.items.map(toCustomerJson), next_cursor: result.nextCursor };
    },
  );

  app.get(
    '/v1/customers/:id',
    {
      preValidation: member,
      schema: {
        operationId: 'getCustomer',
        tags: ['customers'],
        summary: 'Perfil do cliente',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: { 200: customerResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await customers.get(contextOf(request), id);
      return found === null ? sendFailure(reply, 'NOT_FOUND') : toCustomerJson(found);
    },
  );

  app.patch(
    '/v1/customers/:id',
    {
      preValidation: manage,
      schema: {
        operationId: 'updateCustomer',
        tags: ['customers'],
        summary: 'Edita os dados do cliente (o telefone não muda)',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: editable,
        },
        response: { 200: customerResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await customers.update(
        contextOf(request),
        id,
        toInput(request.body as Record<string, unknown>),
      );
      if (!result.ok) return sendFailure(reply, result.reason);
      return toCustomerJson(result.customer);
    },
  );

  app.post(
    '/v1/customers/:id/blacklist',
    {
      preValidation: manage,
      schema: {
        operationId: 'blacklistCustomer',
        tags: ['customers'],
        summary: 'Coloca o cliente na blacklist (os lances dele deixam de valer)',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { reason: { type: 'string', minLength: 1, maxLength: 300 } },
        },
        response: { 200: customerResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { reason } = (request.body ?? {}) as { reason?: string };
      const result = await customers.blacklist(contextOf(request), id, reason ?? null);
      if (!result.ok) return sendFailure(reply, result.reason);
      return toCustomerJson(result.customer);
    },
  );

  app.delete(
    '/v1/customers/:id/blacklist',
    {
      preValidation: manage,
      schema: {
        operationId: 'unblacklistCustomer',
        tags: ['customers'],
        summary: 'Tira o cliente da blacklist',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: { 200: customerResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await customers.unblacklist(contextOf(request), id);
      if (!result.ok) return sendFailure(reply, result.reason);
      return toCustomerJson(result.customer);
    },
  );

  const settlementResponse = {
    type: 'object',
    required: ['id', 'status', 'total_amount', 'shipping_cost', 'items', 'paid_at', 'created_at'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['PENDING', 'PAID'] },
      total_amount: { type: 'string' },
      shipping_cost: { type: 'string' },
      items: { type: 'integer' },
      paid_at: { type: 'string', format: 'date-time', nullable: true },
      created_at: { type: 'string', format: 'date-time' },
    },
  } as const;

  app.get(
    '/v1/customers/:id/settlements',
    {
      preValidation: member,
      schema: {
        operationId: 'listCustomerSettlements',
        tags: ['customers'],
        summary: 'Aba Acerto: acertos do cliente',
        security,
        headers: storeHeader,
        params: uuidParams,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            status: { type: 'string', enum: ['PENDING', 'PAID'] },
          },
        },
        response: { 200: pageOf(settlementResponse), ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { status } = request.query as { status?: 'PENDING' | 'PAID' };
      const result = await customers.settlementsOf(contextOf(request), id, {
        ...pageOptions(request),
        ...(status === undefined ? {} : { status }),
      });
      if (result === null) return sendFailure(reply, 'NOT_FOUND');
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return {
        items: result.items.map((item: SettlementView) => ({
          id: item.id,
          status: item.status,
          total_amount: item.totalAmount,
          shipping_cost: item.shippingCost,
          items: item.items,
          paid_at: item.paidAt?.toISOString() ?? null,
          created_at: item.createdAt.toISOString(),
        })),
        next_cursor: result.nextCursor,
      };
    },
  );

  const bidHistoryResponse = {
    type: 'object',
    required: ['id', 'amount', 'created_at', 'auction_id', 'auction_status', 'won', 'card'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      amount: { type: 'string' },
      created_at: { type: 'string', format: 'date-time' },
      auction_id: { type: 'string', format: 'uuid' },
      auction_status: { type: 'string' },
      won: { type: 'boolean' },
      card: {
        type: 'object',
        required: ['id', 'short_code', 'name'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          short_code: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  } as const;

  app.get(
    '/v1/customers/:id/bids',
    {
      preValidation: member,
      schema: {
        operationId: 'listCustomerBids',
        tags: ['customers'],
        summary: 'Aba Histórico: lances do cliente',
        security,
        headers: storeHeader,
        params: uuidParams,
        querystring: pageQuerySchema,
        response: { 200: pageOf(bidHistoryResponse), ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await customers.bidsOf(contextOf(request), id, pageOptions(request));
      if (result === null) return sendFailure(reply, 'NOT_FOUND');
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return {
        items: result.items.map((item: BidHistoryItem) => ({
          id: item.id,
          amount: item.amount,
          created_at: item.createdAt.toISOString(),
          auction_id: item.auctionId,
          auction_status: item.auctionStatus,
          won: item.won,
          card: { id: item.card.id, short_code: item.card.shortCode, name: item.card.name },
        })),
        next_cursor: result.nextCursor,
      };
    },
  );

  const consignmentResponse = {
    type: 'object',
    required: [
      'id',
      'short_code',
      'name',
      'card_status',
      'commission_pct',
      'sale_amount',
      'commission_amount',
      'net_amount',
    ],
    properties: {
      id: { type: 'string', format: 'uuid' },
      short_code: { type: 'string' },
      name: { type: 'string' },
      card_status: { type: 'string' },
      commission_pct: { type: 'string' },
      sale_amount: { type: 'string', nullable: true },
      commission_amount: { type: 'string', nullable: true },
      net_amount: { type: 'string', nullable: true, description: 'Lance menos a comissão da loja' },
    },
  } as const;

  app.get(
    '/v1/customers/:id/consignments',
    {
      preValidation: finance,
      schema: {
        operationId: 'getCustomerConsignments',
        tags: ['customers'],
        summary: 'Carteira de consignação: cartas, vendido e a receber (exige can_view_finance)',
        description:
          'Valores são estimativas até o acerto: líquido = lance vencedor menos a comissão da loja.',
        security,
        headers: storeHeader,
        params: uuidParams,
        querystring: pageQuerySchema,
        response: {
          200: {
            type: 'object',
            required: ['items', 'next_cursor', 'totals'],
            properties: {
              ...pageOf(consignmentResponse).properties,
              totals: {
                type: 'object',
                required: ['in_stock', 'pending_net', 'sold_net', 'commission'],
                properties: {
                  in_stock: { type: 'integer' },
                  pending_net: { type: 'string', description: 'Vendido, aguardando confirmação' },
                  sold_net: { type: 'string', description: 'Venda confirmada e paga' },
                  commission: { type: 'string' },
                },
              },
            },
          },
          ...failures,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await customers.consignmentsOf(contextOf(request), id, pageOptions(request));
      if (result === null) return sendFailure(reply, 'NOT_FOUND');
      if (result === 'INVALID_CURSOR') return invalidCursor(reply);
      return {
        items: result.items.items.map((item: ConsignmentItem) => ({
          id: item.id,
          short_code: item.shortCode,
          name: item.name,
          card_status: item.cardStatus,
          commission_pct: item.commissionPct,
          sale_amount: item.saleAmount,
          commission_amount: item.commissionAmount,
          net_amount: item.netAmount,
        })),
        next_cursor: result.items.nextCursor,
        totals: {
          in_stock: result.totals.inStock,
          pending_net: result.totals.pendingNet,
          sold_net: result.totals.soldNet,
          commission: result.totals.commission,
        },
      };
    },
  );
}
