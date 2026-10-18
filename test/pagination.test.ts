import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, toPage } from '../src/http/pagination.js';

const id = '4bf92f35-77b3-4da6-a3ce-929d0e0e4736';

describe('cursor', () => {
  it('ida e volta preservam data e id', () => {
    const createdAt = new Date('2026-10-17T12:34:56.789Z');

    const decoded = decodeCursor(encodeCursor({ createdAt, id }));

    expect(decoded).toEqual({ createdAt, id });
  });

  it.each([
    ['lixo', 'texto que não é base64 de JSON'],
    [Buffer.from('{"t":"nao-e-data","i":"' + id + '"}').toString('base64url'), 'data inválida'],
    [
      Buffer.from('{"t":"2026-10-17T00:00:00Z","i":"123"}').toString('base64url'),
      'id que não é uuid',
    ],
    [Buffer.from('{"t":1,"i":2}').toString('base64url'), 'tipos errados'],
    [Buffer.from('[]').toString('base64url'), 'formato errado'],
    ['', 'vazio'],
  ])('recusa %s (%s)', (raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});

describe('toPage', () => {
  const row = (n: number) => ({ id, createdAt: new Date(2026, 0, n) });

  it('devolve cursor quando há mais linhas que o limite', () => {
    const page = toPage([row(1), row(2), row(3)], 2);

    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? '')?.createdAt).toEqual(row(2).createdAt);
  });

  it('não devolve cursor na última página nem em lista vazia', () => {
    expect(toPage([row(1), row(2)], 2).nextCursor).toBeNull();
    expect(toPage([], 2)).toEqual({ items: [], nextCursor: null });
  });
});
