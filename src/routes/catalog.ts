import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import type { CatalogCard, CatalogService } from '../catalog/service.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import { storeHeader } from './store.js';

export interface CatalogRouteDeps {
  hooks: AuthHooks;
  catalog: CatalogService;
}

const security = [{ bearerAuth: [] }];

export const catalogCardSchema = {
  type: 'object',
  required: [
    'id',
    'name',
    'names',
    'number',
    'set_id',
    'set_name',
    'image_url',
    'image_high_url',
    'rarity',
  ],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    names: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Nome em cada idioma sincronizado',
    },
    number: { type: 'string' },
    set_id: { type: 'string', nullable: true },
    set_name: { type: 'string' },
    image_url: {
      type: 'string',
      nullable: true,
      description: 'Miniatura (origem do catálogo; não é copiada)',
    },
    image_high_url: { type: 'string', nullable: true },
    rarity: {
      type: 'string',
      nullable: true,
      description: 'Preenchida na primeira consulta da carta',
    },
  },
} as const;

export const toCatalogJson = (card: CatalogCard) => ({
  id: card.id,
  name: card.name,
  names: card.names,
  number: card.number,
  set_id: card.setId,
  set_name: card.setName,
  image_url: card.imageUrl,
  image_high_url: card.imageHighUrl,
  rarity: card.rarity,
});

export function catalogRoutes(app: FastifyInstance, deps: CatalogRouteDeps): void {
  const { hooks, catalog } = deps;
  const member = [hooks.authenticate, hooks.requireStore];

  app.get(
    '/v1/catalog/search',
    {
      preValidation: member,
      schema: {
        operationId: 'searchCatalog',
        tags: ['catalog'],
        summary: 'Busca as-you-type no catálogo de cartas (nome, número ou coleção)',
        description:
          'Sem acento nem diferença de maiúsculas. Todos os termos precisam aparecer. Mínimo de 2 caracteres.',
        security,
        headers: storeHeader,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            q: { type: 'string', minLength: 1, maxLength: 80 },
            limit: { type: 'integer', minimum: 1, maximum: 20, default: 10 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['items'],
            properties: { items: { type: 'array', items: catalogCardSchema } },
          },
          400: problemSchema,
          401: problemSchema,
          403: problemSchema,
        },
      },
    },
    async (request) => {
      const { q, limit } = request.query as { q: string; limit?: number };
      const items = await catalog.search(q, limit ?? 10);
      return { items: items.map(toCatalogJson) };
    },
  );

  app.get(
    '/v1/catalog/cards/:id',
    {
      preValidation: member,
      schema: {
        operationId: 'getCatalogCard',
        tags: ['catalog'],
        summary: 'Uma carta do catálogo, com a raridade',
        security,
        headers: storeHeader,
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
        },
        response: {
          200: catalogCardSchema,
          401: problemSchema,
          403: problemSchema,
          404: problemSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const card = await catalog.getCard(id);
      if (card === null) {
        return sendProblem(
          reply,
          buildProblem(404, 'Carta não encontrada no catálogo', 'CATALOG_CARD_NOT_FOUND'),
        );
      }
      return toCatalogJson(card);
    },
  );
}
