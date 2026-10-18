import type { FastifyInstance, FastifyReply } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import { DEFAULT_LIMIT, pageQuerySchema } from '../http/pagination.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import type {
  AuctionHistoryItem,
  CardFailure,
  CreateCardInput,
  InventoryCard,
  InventoryService,
  UpdateCardInput,
} from '../inventory/service.js';
import { catalogCardSchema, toCatalogJson } from './catalog.js';
import { storeHeader } from './store.js';

export interface InventoryRouteDeps {
  hooks: AuthHooks;
  inventory: InventoryService;
}

const security = [{ bearerAuth: [] }];
const CONDITIONS = ['MINT', 'NM', 'SP', 'MP', 'HP', 'DMG'] as const;
const ORIGINS = ['OWN', 'CONSIGNED'] as const;
const STATUSES = ['AVAILABLE', 'SCHEDULED', 'AWAITING_CONFIRMATION', 'SOLD'] as const;

const uuidParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const cardResponse = {
  type: 'object',
  required: [
    'id',
    'short_code',
    'catalog',
    'language',
    'condition',
    'is_foil',
    'photos',
    'notes',
    'origin',
    'consignor',
    'commission_pct',
    'status',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: { type: 'string', format: 'uuid' },
    short_code: { type: 'string', description: 'ID curto, sem o "#"' },
    catalog: catalogCardSchema,
    language: { type: 'string', description: 'Idioma da carta física (2 letras)' },
    condition: { type: 'string', enum: CONDITIONS },
    is_foil: { type: 'boolean' },
    photos: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string', nullable: true },
    origin: { type: 'string', enum: ORIGINS },
    consignor: {
      type: 'object',
      nullable: true,
      required: ['id', 'name'],
      properties: { id: { type: 'string', format: 'uuid' }, name: { type: 'string' } },
    },
    commission_pct: { type: 'string', nullable: true },
    status: { type: 'string', enum: STATUSES },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  },
} as const;

const auctionHistoryResponse = {
  type: 'object',
  required: ['id', 'type', 'status', 'start_time', 'end_time', 'initial_bid', 'winning_amount'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    type: { type: 'string' },
    status: { type: 'string' },
    start_time: { type: 'string', format: 'date-time' },
    end_time: { type: 'string', format: 'date-time' },
    initial_bid: { type: 'string' },
    winning_amount: { type: 'string', nullable: true },
  },
} as const;

const fields = {
  tcgdex_id: { type: 'string', minLength: 1, maxLength: 64 },
  language: { type: 'string', pattern: '^[A-Z]{2}$' },
  condition: { type: 'string', enum: CONDITIONS },
  is_foil: { type: 'boolean' },
  notes: { type: 'string', maxLength: 2000, nullable: true },
  origin: {
    type: 'string',
    enum: ORIGINS,
    description: 'Sem valor padrão: quem cadastra escolhe',
  },
  consignor_id: { type: 'string', format: 'uuid', nullable: true },
  commission_pct: { type: 'number', minimum: 0, maximum: 100, nullable: true },
} as const;

const toCardJson = (card: InventoryCard) => ({
  id: card.id,
  short_code: card.shortCode,
  catalog: toCatalogJson(card.catalog),
  language: card.language,
  condition: card.condition,
  is_foil: card.isFoil,
  photos: card.photos,
  notes: card.notes,
  origin: card.origin,
  consignor: card.consignor,
  commission_pct: card.commissionPct,
  status: card.status,
  created_at: card.createdAt.toISOString(),
  updated_at: card.updatedAt.toISOString(),
});

const toAuctionJson = (item: AuctionHistoryItem) => ({
  id: item.id,
  type: item.type,
  status: item.status,
  start_time: item.startTime.toISOString(),
  end_time: item.endTime.toISOString(),
  initial_bid: item.initialBid,
  winning_amount: item.winningAmount,
});

const pct = (value: number | null | undefined): string | null | undefined =>
  typeof value === 'number' ? value.toFixed(2) : value;

const FAILURES: Record<CardFailure, [number, string, string]> = {
  CATALOG_CARD_NOT_FOUND: [422, 'Carta não encontrada no catálogo', 'CATALOG_CARD_NOT_FOUND'],
  CONSIGNOR_NOT_FOUND: [422, 'Consignador não encontrado nesta loja', 'CONSIGNOR_NOT_FOUND'],
  SHORT_CODE_TAKEN: [409, 'Já existe uma carta com este ID curto', 'SHORT_CODE_TAKEN'],
  CARD_LIMIT: [
    409,
    'A loja atingiu o limite de cartas do plano. Fale com a administração',
    'CARD_LIMIT_REACHED',
  ],
  OWNERSHIP_INVALID: [
    422,
    'Carta própria não tem consignador nem comissão; consignada exige os dois',
    'OWNERSHIP_INVALID',
  ],
};

function sendFailure(
  reply: FastifyReply,
  reason: CardFailure | 'NOT_FOUND' | 'CARD_LOCKED' | 'CARD_HAS_HISTORY',
) {
  if (reason === 'NOT_FOUND') {
    return sendProblem(reply, buildProblem(404, 'Carta não encontrada', 'CARD_NOT_FOUND'));
  }
  if (reason === 'CARD_LOCKED') {
    return sendProblem(
      reply,
      buildProblem(409, 'A carta está em leilão ou já foi vendida', 'CARD_LOCKED'),
    );
  }
  if (reason === 'CARD_HAS_HISTORY') {
    return sendProblem(
      reply,
      buildProblem(409, 'A carta já teve leilão e fica no histórico', 'CARD_HAS_HISTORY'),
    );
  }
  const [status, detail, code] = FAILURES[reason];
  return sendProblem(reply, buildProblem(status, detail, code));
}

export function inventoryRoutes(app: FastifyInstance, deps: InventoryRouteDeps): void {
  const { hooks, inventory } = deps;
  const member = [hooks.authenticate, hooks.requireStore];
  const manage = [...member, hooks.requirePermission('can_manage_inventory')];
  const erase = [...member, hooks.requirePermission('can_delete')];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };

  app.post(
    '/v1/cards',
    {
      preValidation: manage,
      schema: {
        operationId: 'createCard',
        tags: ['inventory'],
        summary: 'Cadastra uma carta no estoque (a origem é obrigatória)',
        security,
        headers: storeHeader,
        body: {
          type: 'object',
          required: ['tcgdex_id', 'language', 'condition', 'origin'],
          additionalProperties: false,
          properties: {
            ...fields,
            short_code: {
              type: 'string',
              pattern: '^[A-Za-z0-9]{1,12}$',
              description: 'Opcional. Sem ele a API gera A1, A2, ...',
            },
          },
        },
        response: {
          201: cardResponse,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          409: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const input: CreateCardInput = {
        tcgdexId: body['tcgdex_id'] as string,
        language: body['language'] as string,
        condition: body['condition'] as CreateCardInput['condition'],
        isFoil: (body['is_foil'] as boolean | undefined) ?? false,
        origin: body['origin'] as CreateCardInput['origin'],
        ...(body['notes'] === undefined ? {} : { notes: body['notes'] as string | null }),
        ...(body['consignor_id'] === undefined
          ? {}
          : { consignorId: body['consignor_id'] as string | null }),
        ...(body['commission_pct'] === undefined
          ? {}
          : { commissionPct: pct(body['commission_pct'] as number | null) ?? null }),
        ...(body['short_code'] === undefined
          ? {}
          : { shortCode: (body['short_code'] as string).toUpperCase() }),
      };
      const result = await inventory.create(contextOf(request), input);
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.status(201).send(toCardJson(result.card));
    },
  );

  app.get(
    '/v1/cards',
    {
      preValidation: member,
      schema: {
        operationId: 'listCards',
        tags: ['inventory'],
        summary: 'Lista o estoque, com filtros',
        security,
        headers: storeHeader,
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            status: { type: 'string', enum: STATUSES },
            origin: { type: 'string', enum: ORIGINS },
            consignor_id: { type: 'string', format: 'uuid' },
            q: { type: 'string', maxLength: 80, description: 'Nome, número, coleção ou ID curto' },
            no_auction: {
              type: 'boolean',
              description: 'Só cartas que nunca foram a leilão (para montar o próximo)',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['items', 'next_cursor'],
            properties: {
              items: { type: 'array', items: cardResponse },
              next_cursor: { type: 'string', nullable: true },
            },
          },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const q = request.query as {
        cursor?: string;
        limit?: number;
        status?: InventoryCard['status'];
        origin?: InventoryCard['origin'];
        consignor_id?: string;
        q?: string;
        no_auction?: boolean;
      };
      const result = await inventory.list(contextOf(request), {
        limit: q.limit ?? DEFAULT_LIMIT,
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        ...(q.status === undefined ? {} : { status: q.status }),
        ...(q.origin === undefined ? {} : { origin: q.origin }),
        ...(q.consignor_id === undefined ? {} : { consignorId: q.consignor_id }),
        ...(q.q === undefined ? {} : { q: q.q }),
        ...(q.no_auction === undefined ? {} : { noAuction: q.no_auction }),
      });
      if (result === 'INVALID_CURSOR') {
        return sendProblem(reply, buildProblem(400, 'Cursor inválido', 'INVALID_CURSOR'));
      }
      return { items: result.items.map(toCardJson), next_cursor: result.nextCursor };
    },
  );

  app.get(
    '/v1/cards/:id',
    {
      preValidation: member,
      schema: {
        operationId: 'getCard',
        tags: ['inventory'],
        summary: 'Detalhe da carta, com o histórico de leilões',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: {
          200: {
            type: 'object',
            required: ['card', 'auctions'],
            properties: {
              card: cardResponse,
              auctions: { type: 'array', items: auctionHistoryResponse },
            },
          },
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const found = await inventory.get(contextOf(request), id);
      if (found === null) return sendFailure(reply, 'NOT_FOUND');
      return { card: toCardJson(found.card), auctions: found.auctions.map(toAuctionJson) };
    },
  );

  app.patch(
    '/v1/cards/:id',
    {
      preValidation: manage,
      schema: {
        operationId: 'updateCard',
        tags: ['inventory'],
        summary: 'Edita a carta (só disponível e fora de leilão)',
        security,
        headers: storeHeader,
        params: uuidParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: fields,
        },
        response: {
          200: cardResponse,
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          409: problemSchema,
          422: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, unknown>;
      const input: UpdateCardInput = {
        ...(body['tcgdex_id'] === undefined ? {} : { tcgdexId: body['tcgdex_id'] as string }),
        ...(body['language'] === undefined ? {} : { language: body['language'] as string }),
        ...(body['condition'] === undefined
          ? {}
          : { condition: body['condition'] as UpdateCardInput['condition'] }),
        ...(body['is_foil'] === undefined ? {} : { isFoil: body['is_foil'] as boolean }),
        ...(body['notes'] === undefined ? {} : { notes: body['notes'] as string | null }),
        ...(body['origin'] === undefined
          ? {}
          : { origin: body['origin'] as UpdateCardInput['origin'] }),
        ...(body['consignor_id'] === undefined
          ? {}
          : { consignorId: body['consignor_id'] as string | null }),
        ...(body['commission_pct'] === undefined
          ? {}
          : { commissionPct: pct(body['commission_pct'] as number | null) ?? null }),
      };
      const result = await inventory.update(contextOf(request), id, input);
      if (!result.ok) return sendFailure(reply, result.reason);
      return toCardJson(result.card);
    },
  );

  app.delete(
    '/v1/cards/:id',
    {
      preValidation: erase,
      schema: {
        operationId: 'deleteCard',
        tags: ['inventory'],
        summary: 'Exclui a carta (só disponível e que nunca foi a leilão)',
        security,
        headers: storeHeader,
        params: uuidParams,
        response: {
          204: { type: 'null' },
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
          409: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await inventory.remove(contextOf(request), id);
      if (!result.ok) return sendFailure(reply, result.reason);
      return reply.status(204).send();
    },
  );
}
