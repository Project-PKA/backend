/**
 * Cliente do catálogo TCGdex (https://tcgdex.dev). Só GET, só HTTPS e **só para um host fixo**:
 * nenhum endereço vem de entrada externa (sem SSRF). O `fetch` é injetável para os testes.
 */
export const TCGDEX_BASE = 'https://api.tcgdex.net/v2';

const LANGUAGE = /^[a-z]{2}(-[a-z]{2})?$/;
const CARD_ID = /^[\w.!-]{1,64}$/u;
const USER_AGENT = 'pokemonAuction-catalog-sync/0.1 (+https://github.com/Project-PKA)';

export interface CardBrief {
  id: string;
  localId: string;
  name: string;
  /** Endereço-base da imagem; as variantes são `/low.webp` e `/high.webp`. */
  image: string | null;
}

export interface SetBrief {
  id: string;
  name: string;
}

export interface CardDetail {
  id: string;
  rarity: string | null;
}

export interface TcgdexClient {
  listSets: (language: string) => Promise<{ sets: SetBrief[]; skipped: number }>;
  listCards: (language: string) => Promise<{ cards: CardBrief[]; skipped: number }>;
  /** `null` se a carta não existir. Lança se a API falhar. */
  getCard: (language: string, id: string) => Promise<CardDetail | null>;
}

export interface ClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Teto do tamanho da resposta. A lista completa de cartas tem ~2,5 MB. */
  maxBytes?: number;
}

export function isValidLanguage(language: string): boolean {
  return LANGUAGE.test(language);
}

export function isValidCardId(id: string): boolean {
  return CARD_ID.test(id);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

/** Mantém só os itens bem formados e conta os descartados. */
export function parseCardBriefs(data: unknown): { cards: CardBrief[]; skipped: number } {
  if (!Array.isArray(data)) throw new Error('resposta de cartas não é uma lista');
  const cards: CardBrief[] = [];
  let skipped = 0;
  for (const item of data as unknown[]) {
    const id = isRecord(item) ? text(item['id'], 64) : null;
    const localId = isRecord(item) ? text(item['localId'], 24) : null;
    const name = isRecord(item) ? text(item['name'], 200) : null;
    if (id === null || localId === null || name === null || !CARD_ID.test(id)) {
      skipped += 1;
      continue;
    }
    const image = isRecord(item) ? text(item['image'], 300) : null;
    cards.push({ id, localId, name, image: image?.startsWith('https://') === true ? image : null });
  }
  return { cards, skipped };
}

export function parseSetBriefs(data: unknown): { sets: SetBrief[]; skipped: number } {
  if (!Array.isArray(data)) throw new Error('resposta de coleções não é uma lista');
  const sets: SetBrief[] = [];
  let skipped = 0;
  for (const item of data as unknown[]) {
    const id = isRecord(item) ? text(item['id'], 64) : null;
    const name = isRecord(item) ? text(item['name'], 200) : null;
    if (id === null || name === null) skipped += 1;
    else sets.push({ id, name });
  }
  return { sets, skipped };
}

export function createTcgdexClient(options: ClientOptions = {}): TcgdexClient {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;

  async function getJson(path: string): Promise<{ status: number; body: unknown }> {
    const response = await doFetch(`${TCGDEX_BASE}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (response.status === 404) return { status: 404, body: null };
    if (!response.ok) throw new Error(`TCGdex respondeu ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error('resposta do TCGdex maior que o limite');
    const raw = await response.text();
    if (raw.length > maxBytes) throw new Error('resposta do TCGdex maior que o limite');
    return { status: response.status, body: JSON.parse(raw) as unknown };
  }

  const assertLanguage = (language: string): void => {
    if (!isValidLanguage(language)) throw new Error(`idioma inválido: ${language}`);
  };

  return {
    async listSets(language) {
      assertLanguage(language);
      return parseSetBriefs((await getJson(`/${language}/sets`)).body);
    },
    async listCards(language) {
      assertLanguage(language);
      return parseCardBriefs((await getJson(`/${language}/cards`)).body);
    },
    async getCard(language, id) {
      assertLanguage(language);
      if (!isValidCardId(id)) throw new Error('id de carta inválido');
      const { status, body } = await getJson(`/${language}/cards/${encodeURIComponent(id)}`);
      if (status === 404 || !isRecord(body)) return null;
      return { id: text(body['id'], 64) ?? id, rarity: text(body['rarity'], 80) };
    },
  };
}
