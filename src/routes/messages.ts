import type { FastifyInstance } from 'fastify';

import type { AuthHooks } from '../auth/hooks.js';
import { buildProblem, problemSchema, sendProblem } from '../http/problem.js';
import {
  TEMPLATE_KEYS,
  unknownPlaceholders,
  type MessageTemplateService,
  type TemplateKey,
  type TemplateView,
} from '../messages/service.js';
import { storeHeader } from './store.js';

export interface MessageRouteDeps {
  hooks: AuthHooks;
  templates: MessageTemplateService;
}

const security = [{ bearerAuth: [] }];

const templateResponse = {
  type: 'object',
  required: ['key', 'placeholders', 'default_body', 'custom_body'],
  properties: {
    key: { type: 'string', enum: TEMPLATE_KEYS },
    placeholders: {
      type: 'array',
      items: { type: 'string' },
      description: 'Marcadores aceitos no texto, escritos como `{nome}`',
    },
    default_body: { type: 'string' },
    custom_body: {
      type: 'string',
      nullable: true,
      description: 'Texto da loja; `null` = o bot usa o padrão',
    },
  },
} as const;

const keyParams = {
  type: 'object',
  required: ['key'],
  properties: { key: { type: 'string', enum: TEMPLATE_KEYS } },
} as const;

const toJson = (view: TemplateView) => ({
  key: view.key,
  placeholders: [...view.placeholders],
  default_body: view.defaultBody,
  custom_body: view.customBody,
});

const failures = {
  401: problemSchema,
  403: problemSchema,
  422: problemSchema,
} as const;

/** Modelos das mensagens que o bot publica no grupo (ADR 0006). */
export function messageRoutes(app: FastifyInstance, deps: MessageRouteDeps): void {
  const { hooks, templates } = deps;
  const member = [hooks.authenticate, hooks.requireStore];
  const owner = [...member, hooks.requireOwner];

  const contextOf = (request: { auth: unknown; tenant: unknown }) => {
    const auth = request.auth as { userId: string } | null;
    const tenant = request.tenant as { storeId: string } | null;
    if (auth === null || tenant === null) throw new Error('hooks não definiram o contexto');
    return { storeId: tenant.storeId, userId: auth.userId };
  };

  app.get(
    '/v1/store/message-templates',
    {
      preValidation: member,
      schema: {
        operationId: 'listMessageTemplates',
        tags: ['store'],
        summary: 'Modelos das mensagens do bot no grupo, com o padrão e o texto da loja',
        security,
        headers: storeHeader,
        response: {
          200: {
            type: 'object',
            required: ['items'],
            properties: { items: { type: 'array', items: templateResponse } },
          },
          ...failures,
        },
      },
    },
    async (request) => ({ items: (await templates.list(contextOf(request))).map(toJson) }),
  );

  app.put(
    '/v1/store/message-templates/:key',
    {
      preValidation: owner,
      schema: {
        operationId: 'setMessageTemplate',
        tags: ['store'],
        summary: 'Define o texto da loja para uma mensagem do bot (só o proprietário)',
        description:
          'Só os marcadores listados em `placeholders` da chave valem; outro marcador responde 422.',
        security,
        headers: storeHeader,
        params: keyParams,
        body: {
          type: 'object',
          required: ['body'],
          additionalProperties: false,
          properties: { body: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' } },
        },
        response: { 200: templateResponse, ...failures },
      },
    },
    async (request, reply) => {
      const { key } = request.params as { key: TemplateKey };
      const { body } = request.body as { body: string };
      const result = await templates.set(contextOf(request), key, body);
      if (!result.ok) {
        const names = unknownPlaceholders(key, body)
          .map((name) => `{${name}}`)
          .join(', ');
        return sendProblem(
          reply,
          buildProblem(
            422,
            `Marcador não aceito nesta mensagem: ${names}`,
            'MESSAGE_TEMPLATE_PLACEHOLDER_UNKNOWN',
          ),
        );
      }
      return toJson(result.template);
    },
  );

  app.delete(
    '/v1/store/message-templates/:key',
    {
      preValidation: owner,
      schema: {
        operationId: 'resetMessageTemplate',
        tags: ['store'],
        summary: 'Volta ao texto padrão (só o proprietário)',
        security,
        headers: storeHeader,
        params: keyParams,
        response: { 200: templateResponse, 401: problemSchema, 403: problemSchema },
      },
    },
    async (request) => {
      const { key } = request.params as { key: TemplateKey };
      return toJson(await templates.reset(contextOf(request), key));
    },
  );
}
