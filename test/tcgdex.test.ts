import { describe, expect, it } from 'vitest';

import {
  createTcgdexClient,
  isValidCardId,
  isValidLanguage,
  parseCardBriefs,
  TCGDEX_BASE,
} from '../src/catalog/tcgdex.js';

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (url: string) => Response) {
  const calls: Call[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(respond(url));
  };
  return { impl, calls };
}

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

describe('cliente do TCGdex', () => {
  it('só chama o host fixo, por GET, sem seguir redirecionamento', async () => {
    const { impl, calls } = fakeFetch(() =>
      json([
        {
          id: 'sv03.5-006',
          localId: '006',
          name: 'Charizard ex',
          image: 'https://assets.tcgdex.net/en/sv/sv03.5/006',
        },
      ]),
    );

    const { cards } = await createTcgdexClient({ fetch: impl }).listCards('en');

    expect(cards).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${TCGDEX_BASE}/en/cards`);
    expect(calls[0]?.url.startsWith('https://api.tcgdex.net/')).toBe(true);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeDefined();
  });

  it.each(['EN', '../x', 'en/../../x', 'e', 'pt_br', ''])(
    'recusa o idioma %j',
    async (language) => {
      const { impl, calls } = fakeFetch(() => json([]));

      await expect(createTcgdexClient({ fetch: impl }).listCards(language)).rejects.toThrow(
        'idioma inválido',
      );
      expect(calls).toHaveLength(0);
    },
  );

  it.each(['../../etc/passwd', 'a b', 'x'.repeat(65), '', 'a/b', 'a?b=1'])(
    'recusa o id de carta %j antes de montar a URL',
    async (id) => {
      const { impl, calls } = fakeFetch(() => json({}));

      await expect(createTcgdexClient({ fetch: impl }).getCard('en', id)).rejects.toThrow(
        'id de carta inválido',
      );
      expect(calls).toHaveLength(0);
    },
  );

  it('codifica o id e devolve a raridade; 404 vira null', async () => {
    const { impl, calls } = fakeFetch((url) =>
      url.endsWith('/exu-!') || url.endsWith('/exu-%21')
        ? json({ id: 'exu-!', rarity: 'Rare' })
        : new Response('nao', { status: 404 }),
    );
    const client = createTcgdexClient({ fetch: impl });

    expect(await client.getCard('en', 'exu-!')).toEqual({ id: 'exu-!', rarity: 'Rare' });
    expect(await client.getCard('en', 'nao-existe')).toBeNull();
    expect(calls[0]?.url).toContain('/en/cards/exu-!');
  });

  it('erro HTTP e resposta grande demais falham', async () => {
    const down = createTcgdexClient({
      fetch: fakeFetch(() => new Response('x', { status: 503 })).impl,
    });
    await expect(down.listCards('en')).rejects.toThrow('503');

    const big = createTcgdexClient({
      maxBytes: 100,
      fetch: fakeFetch(() => json([], { headers: { 'content-length': '5000' } })).impl,
    });
    await expect(big.listCards('en')).rejects.toThrow('maior que o limite');

    const bigBody = createTcgdexClient({
      maxBytes: 20,
      fetch: fakeFetch(() => json([{ id: 'a-1', localId: '1', name: 'x'.repeat(50) }])).impl,
    });
    await expect(bigBody.listCards('en')).rejects.toThrow('maior que o limite');
  });
});

describe('validação das respostas', () => {
  it('descarta item malformado e conta', () => {
    const { cards, skipped } = parseCardBriefs([
      { id: 'sv-1', localId: '1', name: 'Ok', image: 'https://assets.tcgdex.net/x' },
      { id: 'sv 2', localId: '2', name: 'Id com espaço' },
      { id: 'sv-3', localId: '3' },
      { id: 'sv-4', localId: '4', name: 'Imagem insegura', image: 'http://evil.example/x' },
      null,
      'texto',
      { id: 'sv-5', localId: 'x'.repeat(30), name: 'Número enorme' },
    ]);

    expect(cards.map((c) => c.id)).toEqual(['sv-1', 'sv-4']);
    expect(cards.find((c) => c.id === 'sv-4')?.image).toBeNull();
    expect(skipped).toBe(5);
  });

  it('resposta que não é lista falha', () => {
    expect(() => parseCardBriefs({ error: 'x' })).toThrow('não é uma lista');
  });

  it('valida idioma e id', () => {
    expect(isValidLanguage('pt')).toBe(true);
    expect(isValidLanguage('pt-br')).toBe(true);
    expect(isValidLanguage('PT')).toBe(false);
    expect(isValidCardId('exu-!')).toBe(true);
    expect(isValidCardId('2024sv-1')).toBe(true);
  });
});
