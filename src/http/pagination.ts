/**
 * Paginação por cursor (ARCHITECTURE.md, seção 4): estável quando entram linhas
 * novas durante a leitura. O cursor é opaco para o cliente: guarda o par
 * (data de criação, id) da última linha entregue.
 */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(
    JSON.stringify({ t: position.createdAt.toISOString(), i: position.id }),
  ).toString('base64url');
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `null` para qualquer cursor malformado (o chamador responde 400). */
export function decodeCursor(raw: string): CursorPosition | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf-8')) as {
      t?: unknown;
      i?: unknown;
    };
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string' || !UUID.test(parsed.i)) {
      return null;
    }
    const createdAt = new Date(parsed.t);
    return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id: parsed.i };
  } catch {
    return null;
  }
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Recebe `limit + 1` linhas e devolve a página e o cursor da próxima, se houver. */
export function toPage<T extends CursorPosition>(rows: T[], limit: number): Page<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const hasMore = rows.length > limit && last !== undefined;
  return { items, nextCursor: hasMore ? encodeCursor(last) : null };
}

/** Schema de consulta compartilhado pelas rotas de lista. */
export const pageQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', maxLength: 300 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, default: DEFAULT_LIMIT },
  },
} as const;
