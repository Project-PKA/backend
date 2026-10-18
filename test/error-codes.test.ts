import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ERROR_CODES_FILE, extractErrorCodes, renderErrorCodes } from '../scripts/error-codes.js';

/**
 * O frontend traduz os erros pelo `code` (ADR 0017). `docs/api/error-codes.json` é a lista desses
 * códigos, extraída do código. Estes testes garantem que ela está em dia e que a extração não deixa
 * escapar nenhum código que os testes de integração já esperam.
 */

const committed = (): { codes: { code: string; status: number | null }[] } =>
  JSON.parse(readFileSync(ERROR_CODES_FILE, 'utf-8')) as {
    codes: { code: string; status: number | null }[];
  };

function listTests(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return listTests(full);
    return full.endsWith('.test.ts') ? [full] : [];
  });
}

describe('catálogo de códigos de erro', () => {
  it('o arquivo commitado está em dia (rode `npm run error-codes:generate`)', () => {
    expect(readFileSync(ERROR_CODES_FILE, 'utf-8')).toBe(renderErrorCodes(extractErrorCodes()));
  });

  it('tem os códigos de todas as formas de emissão', () => {
    const codes = new Set(committed().codes.map((c) => c.code));
    for (const expected of [
      'MISSING_PERMISSION', // parâmetro de função auxiliar (hooks)
      'OWNER_REQUIRED',
      'FORBIDDEN', // parâmetro padrão
      'VALIDATION_ERROR', // framework
      'RATE_LIMITED',
      'INVALID_CURSOR', // literal em buildProblem
      'PUBLIC_LINK_NOT_FOUND',
      'BID_BID_TOO_LOW', // família `BID_${motivo}`
      'BID_CUSTOMER_BLACKLISTED',
      'AUCTION_CARD_NOT_AVAILABLE', // família `AUCTION_${motivo}`
      'SETTLEMENT_AUCTION_NOT_ELIGIBLE',
      'SHIPMENT_TRACKING_REQUIRED',
      'CUSTOMER_PHONE_TAKEN',
      'ADMIN_LIMIT_BELOW_USAGE',
      'CARD_LIMIT_REACHED', // tupla [status, texto, código]
      'SHORT_CODE_TAKEN',
      'PUBLIC_CPF_INVALID', // auxiliar invalidData
    ]) {
      expect(codes.has(expected), expected).toBe(true);
    }
  });

  it('todo código é MAIÚSCULO_COM_UNDERSCORE e não se repete', () => {
    const list = committed().codes.map((c) => c.code);
    expect(new Set(list).size).toBe(list.length);
    for (const code of list) expect(code).toMatch(/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/);
    expect(list.length).toBeGreaterThan(70);
  });

  it('todo código que os testes de integração esperam está no catálogo', () => {
    const catalog = new Set(committed().codes.map((c) => c.code));
    const missing: string[] = [];
    for (const file of listTests('test')) {
      const text = readFileSync(file, 'utf-8');
      for (const match of text.matchAll(/\bcode:\s*'([A-Z][A-Z0-9_]+)'/g)) {
        const code = match[1] ?? '';
        if (!catalog.has(code)) missing.push(`${file}: ${code}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
