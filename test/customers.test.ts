import { describe, expect, it } from 'vitest';

import {
  maskCpf,
  normalizeCep,
  normalizeCpf,
  normalizePhone,
} from '../src/customers/validation.js';

describe('normalizePhone', () => {
  it.each([
    ['(11) 98765-4321', '5511987654321'],
    ['11 3456-7890', '551134567890'],
    ['+55 11 98765-4321', '5511987654321'],
    ['5511987654321', '5511987654321'],
    ['+1 415 555 0132', '14155550132'],
  ])('%s vira %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['', 'abc', '123', '0119876543', '1'.repeat(16)])('recusa %j', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });
});

describe('normalizeCpf', () => {
  it('aceita CPF válido, com ou sem pontuação', () => {
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725');
    expect(normalizeCpf('52998224725')).toBe('52998224725');
  });

  it.each(['529.982.247-24', '111.111.111-11', '000.000.000-00', '1234', '', 'abc'])(
    'recusa %j',
    (input) => {
      expect(normalizeCpf(input)).toBeNull();
    },
  );
});

describe('normalizeCep e maskCpf', () => {
  it('CEP com 8 dígitos', () => {
    expect(normalizeCep('01310-100')).toBe('01310100');
    expect(normalizeCep('1310-100')).toBeNull();
  });

  it('a máscara do CPF só mostra os 2 últimos dígitos', () => {
    expect(maskCpf('52998224725')).toBe('•••.•••.•••-25');
    expect(maskCpf(null)).toBeNull();
  });
});
