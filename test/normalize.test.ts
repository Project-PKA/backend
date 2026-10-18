import { describe, expect, it } from 'vitest';

import {
  buildSearchText,
  escapeLike,
  normalizeText,
  queryTokens,
} from '../src/catalog/normalize.js';

describe('normalizeText', () => {
  it.each([
    ['Flabébé', 'flabebe'],
    ['FLABEBE', 'flabebe'],
    ['Pokémon Açaí (promo)', 'pokemon acai promo'],
    ["Farfetch'd", 'farfetch d'],
    ['Mr. Mime', 'mr mime'],
    ['  Charizard   ex ', 'charizard ex'],
    ['Nidoran♀', 'nidoran'],
  ])('%s vira %s', (input, expected) => {
    expect(normalizeText(input)).toBe(expected);
  });
});

describe('buildSearchText', () => {
  it('junta nomes, número com e sem zeros à esquerda, coleção e id, sem repetir', () => {
    const text = buildSearchText({
      names: ['Charizard ex', 'Charizard ex', 'Charizard ex (pt)'],
      localId: '006',
      setNames: ['151'],
      setId: 'sv03.5',
    });

    expect(text.split(' ')).toEqual(
      expect.arrayContaining(['charizard', 'ex', '006', '6', '151', 'sv03', '5']),
    );
  });

  it('número sem zero fica como está', () => {
    expect(buildSearchText({ names: ['Mew'], localId: '151', setNames: [], setId: null })).toBe(
      'mew 151',
    );
  });
});

describe('queryTokens', () => {
  it('normaliza, tira repetidos e limita a quantidade', () => {
    expect(queryTokens('Charizard  CHARIZARD ex')).toEqual(['charizard', 'ex']);
    expect(queryTokens('a b c d e f g h')).toHaveLength(6);
  });

  it('devolve vazio para entrada curta demais ou só símbolo', () => {
    expect(queryTokens('')).toEqual([]);
    expect(queryTokens('a')).toEqual([]);
    expect(queryTokens('%%%')).toEqual([]);
    expect(queryTokens('6')).toEqual([]);
  });

  it('aceita dois caracteres', () => {
    expect(queryTokens('ex')).toEqual(['ex']);
  });
});

describe('escapeLike', () => {
  it('escapa os curingas do LIKE', () => {
    expect(escapeLike('100%_\\')).toBe('100\\%\\_\\\\');
  });
});
