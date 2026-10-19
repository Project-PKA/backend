import { describe, expect, it } from 'vitest';

import { CpfVault, isSealed } from '../src/security/cpf-vault.js';

const KEY = 'chave-de-teste-do-cpf-0123456789abcdef';

describe('CpfVault', () => {
  it('cifra e decifra, e o texto cifrado não mostra o CPF', () => {
    const vault = new CpfVault(KEY);

    const sealed = vault.seal('52998224725');

    expect(isSealed(sealed.cipher)).toBe(true);
    expect(sealed.cipher).not.toContain('52998224725');
    expect(sealed.cipher).not.toContain('5299');
    expect(sealed.last2).toBe('25');
    expect(vault.open(sealed.cipher)).toBe('52998224725');
  });

  it('cada cifra é diferente (IV novo), mas o hash dos 4 primeiros dígitos é estável', () => {
    const vault = new CpfVault(KEY);

    const one = vault.seal('52998224725');
    const two = vault.seal('52998224725');

    expect(one.cipher).not.toBe(two.cipher);
    expect(one.keyHash).toBe(two.keyHash);
    expect(one.keyHash).toBe(vault.keyHash('5299'));
    expect(one.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(vault.keyHash('5298')).not.toBe(one.keyHash);
  });

  it('outra chave não abre e não gera o mesmo hash', () => {
    const sealed = new CpfVault(KEY).seal('52998224725');
    const other = new CpfVault('outra-chave-de-teste-0123456789abcdef!');

    expect(() => other.open(sealed.cipher)).toThrow();
    expect(other.keyHash('5299')).not.toBe(sealed.keyHash);
  });

  it('recusa valor adulterado, fora do formato e CPF que não tem 11 dígitos', () => {
    const vault = new CpfVault(KEY);
    const sealed = vault.seal('52998224725').cipher;
    const [version, iv, tag, text] = sealed.split('.') as [string, string, string, string];
    const flipped = `${version}.${iv}.${tag}.${text.slice(0, -1)}${text.endsWith('A') ? 'B' : 'A'}`;

    expect(() => vault.open(flipped)).toThrow();
    expect(() => vault.open('52998224725')).toThrow();
    expect(isSealed('52998224725')).toBe(false);
    expect(() => vault.seal('123')).toThrow();
  });
});
