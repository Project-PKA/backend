import type { ReceiptService } from '../settlements/receipt.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import { DEFAULT_LIMIT, pageQuerySchema } from '../http/pagination.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import type {
  AwaitingGroup,
  SettlementFailure,
  SettlementService,
  SettlementView,
} from '../settlements/service.js';
import type {
  ShipmentFailure,
  ShipmentService,
  ShipmentStatus,
  ShipmentView,
} from '../shipments/service.js';
import { storeHeader } from './store.js';

export interface SettlementRouteDeps {
  hooks: AuthHooks;
  settlements: SettlementService;
  shipments: ShipmentService;
  receipts: ReceiptService;
}

const security = [{ bearerAuth: [] }];
const MONEY = '^[0-9]{1,10}(\\.[0-9]{1,2})?$';
const SHIPMENT_STATUSES = ['TO_SHIP', 'SHIPPED', 'DELIVERED'] as const;

const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const money = { type: 'string', pattern: MONEY, description: 'Reais, ex.: "25.50"' } as const;

const itemResponse = {
  type: 'object',
  required: ['auction_id', 'amount', 'card'],
  properties: {
    auction_id: { type: 'string', format: 'uuid' },
    amount: { type: 'string' },
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

const settlementResponse = {
  type: 'object',
  required: [
    'id',
    'status',
    'customer',
    'items_total',
    'shipping_cost',
    'total_amount',
    'paid_at',
    'payment_claimed_at',
    'has_receipt',
    'created_at',
    'shipment',
    'items',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: ['PENDING', 'PAID'] },
    customer: {
      type: 'object',
      required: ['id', 'name', 'kind', 'phone'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['VISITOR', 'CUSTOMER'] },
        phone: { type: 'string' },
      },
    },
    items_total: { type: 'string' },
    shipping_cost: { type: 'string' },
    total_amount: { type: 'string', description: 'Itens + frete informado pela loja' },
    paid_at: { type: 'string', format: 'date-time', nullable: true },
    payment_claimed_at: {
      type: 'string',
      format: 'date-time',
      nullable: true,
      description:
        'O comprador avisou que pagou (a loja ainda precisa conferir e marcar como pago)',
    },
    has_receipt: {
      type: 'boolean',
      description: 'O comprador enviou o comprovante (baixe em GET /v1/settlements/{id}/receipt)',
    },
    created_at: { type: 'string', format: 'date-time' },
    shipment: {
      type: 'object',
      nullable: true,
      required: ['id', 'status', 'tracking_code'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        status: { type: 'string', enum: SHIPMENT_STATUSES },
        tracking_code: { type: 'string', nullable: true },
      },
    },
    items: { type: 'array', items: itemResponse },
  },
} as const;

const awaitingResponse = {
  type: 'object',
  required: ['customer', 'subtotal', 'items'],
  properties: {
    customer: {
      type: 'object',
      required: ['id', 'name', 'kind'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['VISITOR', 'CUSTOMER'] },
      },
    },
    subtotal: { type: 'string' },
    items: {
      type: 'array',
      items: {
        ...itemResponse,
        required: [...itemResponse.required, 'ended_at'],
        properties: {
          ...itemResponse.properties,
          ended_at: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
} as const;

const shipmentResponse = {
  type: 'object',
  required: [
    'id',
    'settlement_id',
    'status',
    'tracking_code',
    'shipped_at',
    'delivered_at',
    'created_at',
    'total_amount',
    'recipient',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    settlement_id: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: SHIPMENT_STATUSES },
    tracking_code: { type: 'string', nullable: true },
    shipped_at: { type: 'string', format: 'date-time', nullable: true },
    delivered_at: { type: 'string', format: 'date-time', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
    total_amount: { type: 'string' },
    recipient: {
      type: 'object',
      required: ['id', 'name', 'phone', 'address'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        phone: { type: 'string' },
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
      },
    },
  },
} as const;

const toSettlementJson = (view: SettlementView) => ({
  id: view.id,
  status: view.status,
  customer: view.customer,
  items_total: view.itemsTotal,
  shipping_cost: view.shippingCost,
  total_amount: view.totalAmount,
  paid_at: view.paidAt?.toISOString() ?? null,
  payment_claimed_at: view.paymentClaimedAt?.toISOString() ?? null,
  has_receipt: view.hasReceipt,
  created_at: view.createdAt.toISOString(),
  shipment:
    view.shipment === null
      ? null
      : {
          id: view.shipment.id,
          status: view.shipment.status,
          tracking_code: view.shipment.trackingCode,
        },
  items: view.items.map((item) => ({
    auction_id: item.auctionId,
    amount: item.amount,
    card: { id: item.card.id, short_code: item.card.shortCode, name: item.card.name },
  })),
});

const toAwaitingJson = (group: AwaitingGroup) => ({
  customer: group.customer,
  subtotal: group.subtotal,
  items: group.items.map((item) => ({
    auction_id: item.auctionId,
    amount: item.amount,
    ended_at: item.endedAt.toISOString(),
    card: { id: item.card.id, short_code: item.card.shortCode, name: item.card.name },
  })),
});

const toShipmentJson = (view: ShipmentView) => ({
  id: view.id,
  settlement_id: view.settlementId,
  status: view.status,
  tracking_code: view.trackingCode,
  shipped_at: view.shippedAt?.toISOString() ?? null,
  delivered_at: view.deliveredAt?.toISOString() ?? null,
  created_at: view.createdAt.toISOString(),
  total_amount: view.totalAmount,
  recipient: view.recipient,
});

const SETTLEMENT_FAILURES: Record<SettlementFailure, [number, string]> = {
  NOT_FOUND: [404, 'Acerto não encontrado'],
  CUSTOMER_NOT_FOUND: [422, 'Comprador não encontrado nesta loja'],
  AUCTION_NOT_ELIGIBLE: [
    422,
    'Algum leilão não existe, não terminou, não foi ganho por este comprador ou já está em um acerto',
  ],
  NOT_PENDING: [409, 'O acerto já foi pago e não pode mais ser alterado'],
};

const SHIPMENT_FAILURES: Record<ShipmentFailure, [number, string]> = {
  NOT_FOUND: [404, 'Envio não encontrado'],
  INVALID_TRANSITION: [
    409,
    'Transição de estado inválida: o envio só avança (a enviar, enviado, entregue)',
  ],
  TRACKING_REQUIRED: [422, 'Informe o código de rastreio para marcar como enviado'],
};

const sendSettlementFailure = (reply: FastifyReply, reason: SettlementFailure) => {
  const [status, detail] = SETTLEMENT_FAILURES[reason];
  return sendProblem(reply, buildProblem(status, detail, `SETTLEMENT_${reason}`));
};

const failures = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
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

export function settlementRoutes(app: FastifyInstance, deps: SettlementRouteDeps): void {
  const { hooks, settlements, shipments, receipts } = deps;
  const member = [hooks.authenticate, hooks.requireStore];
  const manage = [...member, hooks.requirePermission('can_manage_auctions')];
  const finance = [...member, hooks.requirePermission('can_view_finance')];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };

  app.get(
    '/v1/settlements/awaiting',
    {
      preValidation: member,
      schema: {
        operationId: 'listAwaitingSettlement',
        tags: ['settlements'],
        summary: 'Compradores com leilões ganhos e ainda sem acerto, agrupados por comprador',
        security,
        headers: storeHeader,
        response: {
          200: {
            type: 'object',
            required: ['items'],
            properties: { items: { type: 'array', items: awaitingResponse } },
          },
          ...failures,
        },
      },
    },
    async (request) => ({
      items: (await settlements.awaiting(contextOf(request))).map(toAwaitingJson),
    }),
  );

  app.post(
    '/v1/settlements',
    {
      preValidation: manage,
      schema: {
        operationId: 'createSettlement',
        tags: ['settlements'],
        summary: 'Cria o acerto de um comprador com os leilões que ele ganhou',
        description:
          'Total = itens + frete informado pela loja. Cada leilão entra em no máximo um acerto. A plataforma não cobra nem garante o pagamento.',
        security,
        headers: storeHeader,
        body: {
          type: 'object',
          required: ['customer_id', 'auction_ids'],
          additionalProperties: false,
          properties: {
            customer_id: { type: 'string', format: 'uuid' },
            auction_ids: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              items: { type: 'string', format: 'uuid' },
            },
            shipping_cost: { ...money, default: '0' },
          },
        },
        response: { 201: settlementResponse, ...failures },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        customer_id: string;
        auction_ids: string[];
        shipping_cost?: string;
      };
      const result = await settlements.create(contextOf(request), {
        customerId: body.customer_id,
        auctionIds: body.auction_ids,
        shippingCost: body.shipping_cost ?? '0',
      });
      if (!result.ok) return sendSettlementFailure(reply, result.reason);
      return reply.status(201).send(toSettlementJson(result.settlement));
    },
  );

  app.get(
    '/v1/settlements',
    {
      preValidation: member,
      schema: {
        operationId: 'listSettlements',
        tags: ['settlements'],
        summary: 'Lista os acertos',
        security,
        headers: storeHeader,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            status: { type: 'string', enum: ['PENDING', 'PAID'] },
            customer_id: { type: 'string', format: 'uuid' },
          },
        },
        response: { 200: pageOf(settlementResponse), ...failures },
      },
    },
    async (request, reply) => {
      const q = request.query as {
        cursor?: string;
        limit?: number;
        status?: 'PENDING' | 'PAID';
        customer_id?: string;
      };
      const result = await settlements.list(contextOf(request), {
        limit: q.limit ?? DEFAULT_LIMIT,
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.customer_id === undefined ? {} : { customerId: q.customer_id }),
      });
      if (result === 'INVALID_CURSOR') {
        return sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));
      }
      return { items: result.items.map(toSettlementJson), next_cursor: result.nextCursor };
    },
  );

  app.get(
    '/v1/settlements/:id',
    {
      preValidation: member,
      schema: {
        operationId: 'getSettlement',
        tags: ['settlements'],
        summary: 'Detalhe do acerto, com os itens',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: { 200: settlementResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await settlements.get(contextOf(request), id);
      return found === null ? sendSettlementFailure(reply, 'NOT_FOUND') : toSettlementJson(found);
    },
  );

  app.patch(
    '/v1/settlements/:id',
    {
      preValidation: manage,
      schema: {
        operationId: 'updateSettlement',
        tags: ['settlements'],
        summary: 'Altera o frete de um acerto pendente (o total acompanha)',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          required: ['shipping_cost'],
          additionalProperties: false,
          properties: { shipping_cost: money },
        },
        response: { 200: settlementResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { shipping_cost: shippingCost } = request.body as { shipping_cost: string };
      const result = await settlements.setShipping(contextOf(request), id, shippingCost);
      if (!result.ok) return sendSettlementFailure(reply, result.reason);
      return toSettlementJson(result.settlement);
    },
  );

  app.get(
    '/v1/settlements/:id/receipt',
    {
      preValidation: manage,
      schema: {
        operationId: 'getSettlementReceipt',
        tags: ['settlements'],
        summary: 'Baixa o comprovante que o comprador enviou (imagem)',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: { 401: problemSchema, 403: problemSchema, 404: problemSchema },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await receipts.read(contextOf(request), id);
      if (found === null) {
        return sendProblem(
          reply,
          buildProblem(404, 'Comprovante não encontrado', 'RECEIPT_NOT_FOUND'),
        );
      }
      return reply
        .header('Content-Type', found.contentType)
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', 'inline')
        .send(found.data);
    },
  );

  app.delete(
    '/v1/settlements/:id',
    {
      preValidation: manage,
      schema: {
        operationId: 'deleteSettlement',
        tags: ['settlements'],
        summary: 'Desfaz um acerto pendente; os leilões voltam à fila',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: { 204: { type: 'null' }, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await settlements.remove(contextOf(request), id);
      if (!result.ok) return sendSettlementFailure(reply, result.reason);
      await receipts.discard(result.receiptFile);
      return reply.status(204).send();
    },
  );

  app.post(
    '/v1/settlements/:id/paid',
    {
      preValidation: finance,
      schema: {
        operationId: 'markSettlementPaid',
        tags: ['settlements'],
        summary: 'Marca o acerto como pago (só a loja; exige can_view_finance)',
        description:
          'As cartas viram vendidas e o envio entra na fila. Nunca é chamado pelo comprador: o "já paguei" dele só avisa a loja.',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: { 200: settlementResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await settlements.markPaid(contextOf(request), id);
      if (!result.ok) return sendSettlementFailure(reply, result.reason);
      return toSettlementJson(result.settlement);
    },
  );

  app.get(
    '/v1/shipments',
    {
      preValidation: member,
      schema: {
        operationId: 'listShipments',
        tags: ['settlements'],
        summary: 'Fila de envios das vendas pagas',
        security,
        headers: storeHeader,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            status: { type: 'string', enum: SHIPMENT_STATUSES },
          },
        },
        response: { 200: pageOf(shipmentResponse), ...failures },
      },
    },
    async (request, reply) => {
      const q = request.query as { cursor?: string; limit?: number; status?: ShipmentStatus };
      const result = await shipments.list(contextOf(request), {
        limit: q.limit ?? DEFAULT_LIMIT,
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.status === undefined ? {} : { status: q.status }),
      });
      if (result === 'INVALID_CURSOR') {
        return sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));
      }
      return { items: result.items.map(toShipmentJson), next_cursor: result.nextCursor };
    },
  );

  app.patch(
    '/v1/shipments/:id',
    {
      preValidation: manage,
      schema: {
        operationId: 'updateShipment',
        tags: ['settlements'],
        summary: 'Atualiza o envio: rastreio e andamento (a enviar → enviado → entregue)',
        description:
          'Não envia mensagem a ninguém (ADR 0006): a loja avisa o comprador por conta própria.',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            status: { type: 'string', enum: SHIPMENT_STATUSES },
            tracking_code: { type: 'string', pattern: '^[A-Za-z0-9._/-]{4,60}$', nullable: true },
          },
        },
        response: { 200: shipmentResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { status?: ShipmentStatus; tracking_code?: string | null };
      const result = await shipments.update(contextOf(request), id, {
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.tracking_code === undefined ? {} : { trackingCode: body.tracking_code }),
      });
      if (!result.ok) {
        const [status, detail] = SHIPMENT_FAILURES[result.reason];
        return sendProblem(reply, buildProblem(status, detail, `SHIPMENT_${result.reason}`));
      }
      return toShipmentJson(result.shipment);
    },
  );
}
