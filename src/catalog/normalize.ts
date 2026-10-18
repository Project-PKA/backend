/**
 * Texto de busca do catálogo (ADR 0009). A MESMA função normaliza o que é gravado no sync e o
 * que a pessoa digita, então "Flabébé", "flabebe" e "FLABEBE" se encontram.
 */
const MARKS = /\p{M}/gu;
const NOT_WORD = /[^\p{L}\p{N}\s]/gu;
const SPACES = /\s+/g;

export function normalizeText(input: string): string {
  return input
    .normalize('NFD')
    .replace(MARKS, '')
    .toLowerCase()
    .replace(NOT_WORD, ' ')
    .replace(SPACES, ' ')
    .trim();
}

const withoutLeadingZeros = (value: string): string => value.replace(/^0+(?=\d)/, '');

export interface SearchTextInput {
  /** Nomes da carta em cada idioma sincronizado. */
  names: string[];
  /** Número da carta na coleção, como vem do catálogo (ex.: "006"). */
  localId: string;
  setNames: string[];
  setId: string | null;
}

/** Junta tudo que a pessoa pode digitar para achar a carta, sem repetir. */
export function buildSearchText(input: SearchTextInput): string {
  const parts = [
    ...input.names,
    input.localId,
    withoutLeadingZeros(input.localId),
    ...input.setNames,
    input.setId ?? '',
  ]
    .map(normalizeText)
    .filter((part) => part !== '');
  return [...new Set(parts)].join(' ');
}

/** Termos da busca: normalizados, sem repetição, no máximo `max`. Vazio se for curto demais. */
export function queryTokens(query: string, max = 6): string[] {
  const tokens = [
    ...new Set(
      normalizeText(query)
        .split(' ')
        .filter((t) => t !== ''),
    ),
  ].slice(0, max);
  const length = tokens.reduce((sum, token) => sum + token.length, 0);
  return length < 2 ? [] : tokens;
}

/** Escapa `%`, `_` e `\` para uso em LIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
