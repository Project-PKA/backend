import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/** Erro no formato RFC 9457 (application/problem+json), com `code` de negócio. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code?: string;
}

export const problemSchema = {
  type: 'object',
  required: ['type', 'title', 'status'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
  },
} as const;

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Content Too Large',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

export function buildProblem(status: number, detail?: string, code?: string): Problem {
  return {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(code === undefined ? {} : { code }),
  };
}

export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply.status(problem.status).type('application/problem+json').send(problem);
}

/** Código de negócio estável para os erros que o framework gera sozinho. */
function codeFor(status: number, error: FastifyError): string | undefined {
  if (status === 429) return 'RATE_LIMITED';
  if (status === 400 && error.validation !== undefined) return 'VALIDATION_ERROR';
  return undefined;
}

export function errorHandler(
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const status = error.statusCode !== undefined && error.statusCode >= 400 ? error.statusCode : 500;
  if (status >= 500) {
    request.log.error({ err: error }, 'erro não tratado');
  }
  // Nunca vaza detalhe interno em erro 5xx.
  const detail = status >= 500 ? undefined : error.message;
  return sendProblem(reply, {
    ...buildProblem(status, detail, codeFor(status, error)),
    instance: request.url,
  });
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return sendProblem(reply, {
    ...buildProblem(404, 'Rota não encontrada'),
    instance: request.url,
  });
}
