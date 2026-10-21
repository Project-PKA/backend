import type { FastifyRequest } from 'fastify';

/**
 * Serializadores do log (SECURITY.md: nenhum telefone, e-mail, CPF, token ou texto de lance em log).
 * O padrão do Fastify registra a URL inteira e o objeto de erro com todos os campos; os dois podem
 * carregar dado pessoal, então aqui eles são reduzidos ao que ajuda a depurar.
 */

/** O caminho sem a query string: `?q=` das buscas leva nome e telefone do cliente. */
export const pathOf = (url: string): string => {
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
};

export function serializeRequest(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: pathOf(request.url),
    host: request.host,
    remoteAddress: request.ip,
  };
}

const NEWLINE = String.fromCodePoint(10);

const isDatabaseError = (error: Error): error is Error & Record<string, unknown> =>
  'severity' in error && typeof (error as { code?: unknown }).code === 'string';

export interface SerializedError {
  [key: string]: unknown;
  type: string;
  message: string;
  stack: string;
}

/**
 * Erro do Postgres: só a classe, o código SQLSTATE e onde (tabela e restrição). A `message` e o
 * `detail` do banco repetem o valor que falhou (`Key (phone)=(5511...) already exists`).
 */
export function serializeError(error: Error): SerializedError {
  if (!isDatabaseError(error)) {
    return { type: error.name, message: error.message, stack: error.stack ?? '' };
  }
  const pick = (key: string): string | undefined =>
    typeof error[key] === 'string' ? error[key] : undefined;
  return {
    type: error.name,
    message: 'erro do banco de dados',
    sqlstate: pick('code'),
    table: pick('table'),
    constraint: pick('constraint'),
    routine: pick('routine'),
    // A primeira linha da pilha repete a mensagem do banco: ficam só as chamadas.
    stack: (error.stack ?? '').split(NEWLINE).slice(1, 9).join(NEWLINE),
  };
}
