import { describe, expect, it } from 'vitest';

import { botLoginFromEnv } from '../src/db/roles.js';

describe('botLoginFromEnv', () => {
  it('sem senha não há bot', () => {
    expect(botLoginFromEnv({})).toBeNull();
    expect(botLoginFromEnv({ DB_BOT_PASSWORD: '' })).toBeNull();
  });

  it('usa bot_api por padrão e aceita outro nome válido', () => {
    const secret = 'x'.repeat(24);
    expect(botLoginFromEnv({ DB_BOT_PASSWORD: secret })).toEqual({
      name: 'bot_api',
      password: secret,
    });
    expect(botLoginFromEnv({ DB_BOT_PASSWORD: secret, DB_BOT_USER: 'bot_loja' })?.name).toBe(
      'bot_loja',
    );
  });

  it('recusa senha curta e nome fora do padrão', () => {
    expect(() => botLoginFromEnv({ DB_BOT_PASSWORD: 'curta' })).toThrow('24 caracteres');
    expect(() =>
      botLoginFromEnv({ DB_BOT_PASSWORD: 'x'.repeat(24), DB_BOT_USER: 'Bot; DROP' }),
    ).toThrow('DB_BOT_USER inválido');
  });
});
