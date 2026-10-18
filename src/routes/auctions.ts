import type { FastifyInstance, FastifyReply } from 'fastify';

import type {
  AuctionFailure,
  AuctionService,
  AuctionView,
  BidOutcome,
  BidView,
  CreateAuctionInput,
  UpdateAuctionInput,
} from '../auctions/service.js';
import type { AuthHooks } from '../auth/hooks.js';
import { DEFAULT_LIMIT, pageQuerySchema } from '../http/pagination.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import { catalogCardSchema, toCatalogJson } from './catalog.js';
import { storeHeader } from './store.js';

export interface AuctionRouteDeps {
  hooks: AuthHooks;
  auctions: AuctionService;
}

const security = [{ bearerAuth: [] }];
const TYPES = ['FREE_BID', 'POLL'] as const;
const STATUSES = ['PENDING', 'ACTIVE', 'PAUSED_FOR_VALIDATION', 'FINISHED', 'CANCELLED'] as const;
const MONEY = '^[0-9]{1,10}(\\.[0-9]{1,2})?$';

const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const money = { type: 'string', pattern: MONEY, description: 'Reais, ex.: "25.50"' } as const;

const auctionResponse = {
  type: 'object',
  required: [
    'id',
    'card',
    'type',
    'status',
    'start_time',
    'end_time',
    'initial_bid',
    'min_increment',
    'max_poll_value',
    'ceiling_alert',
    'current_bid',
    'bid_count',
    'leader',
    'winning_bid_id',
    'created_at',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    card: {
      type: 'object',
      required: ['id', 'short_code', 'language', 'condition', 'catalog'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        short_code: { type: 'string' },
        language: { type: 'string' },
        condition: { type: 'string' },
        catalog: catalogCardSchema,
      },
    },
    type: { type: 'string', enum: TYPES },
    status: { type: 'string', enum: STATUSES },
    start_time: { type: 'string', format: 'date-time' },
    end_time: { type: 'string', format: 'date-time' },
    initial_bid: { type: 'string' },
    min_increment: { type: 'string' },
    max_poll_value: { type: 'string', nullable: true },
    ceiling_alert: {
      type: 'boolean',
      description: 'Enquete que atingiu o teto e espera o lojista',
    },
    current_bid: { type: 'string', nullable: true },
    bid_count: { type: 'integer' },
    leader: {
      type: 'object',
      nullable: true,
      required: ['id', 'name'],
      properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
    },
    winning_bid_id: { type: 'string', format: 'uuid', nullable: true },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const bidResponse = {
  type: 'object',
  required: ['id', 'amount', 'created_at', 'customer'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    amount: { type: 'string' },
    created_at: { type: 'string', format: 'date-time' },
    customer: {
      type: 'object',
      required: ['id', 'name', 'phone_masked'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string' },
        phone_masked: { type: 'string', description: 'Telefone com o miolo oculto' },
      },
    },
  },
} as const;

const toAuctionJson = (view: AuctionView) => ({
  id: view.id,
  card: {
    id: view.card.id,
    short_code: view.card.shortCode,
    language: view.card.language,
    condition: view.card.condition,
    catalog: toCatalogJson(view.card.catalog),
  },
  type: view.type,
  status: view.status,
  start_time: view.startTime.toISOString(),
  end_time: view.endTime.toISOString(),
  initial_bid: view.initialBid,
  min_increment: view.minIncrement,
  max_poll_value: view.maxPollValue,
  ceiling_alert: view.ceilingAlert,
  current_bid: view.currentBid,
  bid_count: view.bidCount,
  leader: view.leader,
  winning_bid_id: view.winningBidId,
  created_at: view.createdAt.toISOString(),
});

const toBidJson = (bid: BidView) => ({
  id: bid.id,
  amount: bid.amount,
  created_at: bid.createdAt.toISOString(),
  customer: {
    id: bid.customer.id,
    name: bid.customer.name,
    phone_masked: bid.customer.phoneMasked,
  },
});

const FAILURES: Record<AuctionFailure, [number, string]> = {
  NOT_FOUND: [404, 'Leilão não encontrado'],
  CARD_NOT_FOUND: [404, 'Carta não encontrada'],
  CARD_NOT_AVAILABLE: [409, 'A carta não está disponível ou já está em um leilão'],
  INVALID_PERIOD: [422, 'Período inválido: o fim precisa vir depois do início e do momento atual'],
  INVALID_VALUES: [
    422,
    'Valores inválidos: lance e incremento positivos; enquete exige teto acima do lance inicial; lance livre não tem teto',
  ],
  AUCTION_LOCKED: [409, 'O leilão não pode mais ser alterado desta forma'],
  NOT_PAUSED: [409, 'O leilão não está aguardando validação'],
  NOT_LIVE: [409, 'O leilão não está em andamento'],
};

const sendFailure = (reply: FastifyReply, reason: AuctionFailure) => {
  const [status, detail] = FAILURES[reason];
  return sendProblem(reply, buildProblem(status, detail, `AUCTION_${reason}`));
};

const BID_REFUSALS: Record<Exclude<BidOutcome, 'ACCEPTED'>, [number, string]> = {
  AUCTION_NOT_FOUND: [404, 'Leilão não encontrado'],
  AUCTION_NOT_ACTIVE: [409, 'O leilão não está recebendo lances'],
  NOT_STARTED: [409, 'O leilão ainda não começou'],
  ENDED: [409, 'O leilão já terminou'],
  CUSTOMER_NOT_FOUND: [422, 'Cliente não encontrado nesta loja'],
  CUSTOMER_BLACKLISTED: [422, 'Cliente na blacklist não pode dar lance'],
  INVALID_AMOUNT: [422, 'Valor de lance inválido'],
  BID_TOO_LOW: [422, 'Lance abaixo do mínimo'],
};

const failures = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  422: problemSchema,
} as const;

export function auctionRoutes(app: FastifyInstance, deps: AuctionRouteDeps): void {
  const { hooks, auctions } = deps;
  const member = [hooks.authenticate, hooks.requireStore];
  const manage = [...member, hooks.requirePermission('can_manage_auctions')];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };

  const termsProperties = {
    type: { type: 'string', enum: TYPES },
    end_time: { type: 'string', format: 'date-time' },
    initial_bid: money,
    min_increment: money,
    max_poll_value: { ...money, nullable: true, description: 'Só enquete. Acima do lance inicial' },
  } as const;

  app.post(
    '/v1/auctions',
    {
      preValidation: manage,
      schema: {
        operationId: 'createAuction',
        tags: ['auctions'],
        summary: 'Cria o leilão de uma carta (agendado, ou já em andamento se sem start_time)',
        description:
          'Sem `start_time` o leilão abre agora. "Deixar para depois" é não chamar esta rota: a carta segue disponível.',
        security,
        headers: storeHeader,
        body: {
          type: 'object',
          required: ['card_id', 'type', 'end_time', 'initial_bid', 'min_increment'],
          additionalProperties: false,
          properties: {
            ...termsProperties,
            card_id: { type: 'string', format: 'uuid' },
            start_time: { type: 'string', format: 'date-time' },
          },
        },
        response: { 201: auctionResponse, ...failures },
      },
    },
    async (request, reply) => {
      const body = request.body as Record<string, string | undefined>;
      const input: CreateAuctionInput = {
        cardId: body['card_id'] ?? '',
        type: body['type'] as CreateAuctionInput['type'],
        startTime: body['start_time'] === undefined ? null : new Date(body['start_time']),
        endTime: new Date(body['end_time'] ?? ''),
        initialBid: body['initial_bid'] ?? '',
        minIncrement: body['min_increment'] ?? '',
        maxPollValue: body['max_poll_value'] ?? null,
      };
      const result = await auctions.create(contextOf(request), input);
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.status(201).send(toAuctionJson(result.auction));
    },
  );

  app.get(
    '/v1/auctions',
    {
      preValidation: member,
      schema: {
        operationId: 'listAuctions',
        tags: ['auctions'],
        summary: 'Lista os leilões, do mais novo para o mais antigo',
        security,
        headers: storeHeader,
        querystring: {
          ...pageQuerySchema,
          properties: { ...pageQuerySchema.properties, status: { type: 'string', enum: STATUSES } },
        },
        response: {
          200: {
            type: 'object',
            required: ['items', 'next_cursor'],
            properties: {
              items: { type: 'array', items: auctionResponse },
              next_cursor: { type: 'string', nullable: true },
            },
          },
          ...failures,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as {
        cursor?: string;
        limit?: number;
        status?: (typeof STATUSES)[number];
      };
      const result = await auctions.list(contextOf(request), {
        limit: q.limit ?? DEFAULT_LIMIT,
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.status === undefined ? {} : { status: q.status }),
      });
      if (result === 'INVALID_CURSOR') {
        return sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));
      }
      return { items: result.items.map(toAuctionJson), next_cursor: result.nextCursor };
    },
  );

  app.get(
    '/v1/auctions/affected',
    {
      preValidation: member,
      schema: {
        operationId: 'listAffectedAuctions',
        tags: ['auctions'],
        summary: 'Leilões em andamento afetados por um WhatsApp desconectado',
        description:
          'Vazio quando o WhatsApp da loja está ONLINE. Lances enviados durante a queda podem não ter sido registrados.',
        security,
        headers: storeHeader,
        response: {
          200: {
            type: 'object',
            required: ['whatsapp_status', 'items'],
            properties: {
              whatsapp_status: { type: 'string', enum: ['ONLINE', 'OFFLINE', 'QR_READY'] },
              items: { type: 'array', items: auctionResponse },
            },
          },
          ...failures,
        },
      },
    },
    async (request) => {
      const result = await auctions.affected(contextOf(request));
      return { whatsapp_status: result.whatsappStatus, items: result.auctions.map(toAuctionJson) };
    },
  );

  app.post(
    '/v1/auctions/extend',
    {
      preValidation: manage,
      schema: {
        operationId: 'extendAllAuctions',
        tags: ['auctions'],
        summary: 'Estende o fim de todos os leilões em andamento',
        security,
        headers: storeHeader,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { minutes: { type: 'integer', minimum: 1, maximum: 1440, default: 30 } },
        },
        response: {
          200: {
            type: 'object',
            required: ['extended'],
            properties: { extended: { type: 'array', items: { type: 'string', format: 'uuid' } } },
          },
          ...failures,
        },
      },
    },
    async (request, reply) => {
      const { minutes } = (request.body ?? {}) as { minutes?: number };
      const result = await auctions.extend(contextOf(request), minutes ?? 30);
      if (!result.ok) return sendFailure(reply, result.reason);
      return { extended: result.extended };
    },
  );

  app.get(
    '/v1/auctions/:id',
    {
      preValidation: member,
      schema: {
        operationId: 'getAuction',
        tags: ['auctions'],
        summary: 'Sala de lances: o leilão e os lances (maior primeiro)',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: {
          200: {
            type: 'object',
            required: ['auction', 'bids'],
            properties: {
              auction: auctionResponse,
              bids: { type: 'array', items: bidResponse },
            },
          },
          ...failures,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await auctions.get(contextOf(request), id);
      if (found === null) return sendFailure(reply, 'NOT_FOUND');
      return { auction: toAuctionJson(found.auction), bids: found.bids.map(toBidJson) };
    },
  );

  app.patch(
    '/v1/auctions/:id',
    {
      preValidation: manage,
      schema: {
        operationId: 'updateAuction',
        tags: ['auctions'],
        summary: 'Edita ou reagenda o leilão',
        description:
          'Pendente: qualquer campo. Em andamento: só `end_time`, e nunca para antes de agora.',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: { ...termsProperties, start_time: { type: 'string', format: 'date-time' } },
        },
        response: { 200: auctionResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, string | null | undefined>;
      const input: UpdateAuctionInput = {
        ...(body['type'] === undefined ? {} : { type: body['type'] as UpdateAuctionInput['type'] }),
        ...(body['start_time'] == null ? {} : { startTime: new Date(body['start_time']) }),
        ...(body['end_time'] == null ? {} : { endTime: new Date(body['end_time']) }),
        ...(body['initial_bid'] == null ? {} : { initialBid: body['initial_bid'] }),
        ...(body['min_increment'] == null ? {} : { minIncrement: body['min_increment'] }),
        ...(body['max_poll_value'] === undefined ? {} : { maxPollValue: body['max_poll_value'] }),
      };
      const result = await auctions.update(contextOf(request), id, input);
      if (!result.ok) return sendFailure(reply, result.reason);
      return toAuctionJson(result.auction);
    },
  );

  app.post(
    '/v1/auctions/:id/cancel',
    {
      preValidation: manage,
      schema: {
        operationId: 'cancelAuction',
        tags: ['auctions'],
        summary: 'Cancela o leilão (pendente, em andamento ou aguardando validação)',
        description: 'A carta volta a ficar disponível; os lances ficam no histórico.',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: { 200: auctionResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await auctions.cancel(contextOf(request), id);
      if (!result.ok) return sendFailure(reply, result.reason);
      return toAuctionJson(result.auction);
    },
  );

  app.post(
    '/v1/auctions/:id/resolve',
    {
      preValidation: manage,
      schema: {
        operationId: 'resolveAuctionPoll',
        tags: ['auctions'],
        summary: 'Decide a enquete que atingiu o teto: aprovar o encerramento ou manter aberta',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          required: ['decision'],
          additionalProperties: false,
          properties: { decision: { type: 'string', enum: ['APPROVE', 'KEEP_OPEN'] } },
        },
        response: { 200: auctionResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { decision } = request.body as { decision: 'APPROVE' | 'KEEP_OPEN' };
      const result = await auctions.resolve(contextOf(request), id, decision);
      if (!result.ok) return sendFailure(reply, result.reason);
      return toAuctionJson(result.auction);
    },
  );

  app.post(
    '/v1/auctions/:id/extend',
    {
      preValidation: manage,
      schema: {
        operationId: 'extendAuction',
        tags: ['auctions'],
        summary: 'Estende o fim de um leilão em andamento',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { minutes: { type: 'integer', minimum: 1, maximum: 1440, default: 30 } },
        },
        response: { 200: auctionResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { minutes } = (request.body ?? {}) as { minutes?: number };
      const context = contextOf(request);
      const result = await auctions.extend(context, minutes ?? 30, id);
      if (!result.ok) return sendFailure(reply, result.reason);
      const found = await auctions.get(context, id);
      if (found === null) return sendFailure(reply, 'NOT_FOUND');
      return toAuctionJson(found.auction);
    },
  );

  app.post(
    '/v1/auctions/:id/bids',
    {
      preValidation: manage,
      schema: {
        operationId: 'registerBid',
        tags: ['auctions'],
        summary: 'Registra um lance manualmente (a regra é a mesma que o bot usa)',
        description:
          'Recusas voltam como `problem+json` com `code` `BID_<MOTIVO>`; em `BID_BID_TOO_LOW` o `detail` traz o valor mínimo.',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          required: ['customer_id', 'amount'],
          additionalProperties: false,
          properties: { customer_id: { type: 'string', format: 'uuid' }, amount: money },
        },
        response: {
          201: {
            type: 'object',
            required: ['bid_id', 'amount', 'auction_status', 'ceiling_reached'],
            properties: {
              bid_id: { type: 'string', format: 'uuid' },
              amount: { type: 'string' },
              auction_status: { type: 'string', enum: STATUSES },
              ceiling_reached: { type: 'boolean' },
            },
          },
          ...failures,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { customer_id: string; amount: string };
      const result = await auctions.placeBid(contextOf(request), {
        auctionId: id,
        customerId: body.customer_id,
        amount: body.amount,
        rawMessage: 'Lance registrado manualmente pelo painel',
      });
      if (result.outcome !== 'ACCEPTED') {
        const [status, detail] = BID_REFUSALS[result.outcome];
        const extra = result.outcome === 'BID_TOO_LOW' ? ` (mínimo ${result.minAmount ?? ''})` : '';
        return sendProblem(reply, buildProblem(status, detail + extra, `BID_${result.outcome}`));
      }
      return reply.status(201).send({
        bid_id: result.bidId,
        amount: result.currentAmount,
        auction_status: result.status,
        ceiling_reached: result.ceilingReached,
      });
    },
  );
}
