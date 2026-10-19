import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encryptLegacyCpfs } from '../src/db/encrypt-legacy-cpf.js';
import { SEED_IDS } from '../src/db/seed.js';
import { CpfVault, isSealed } from '../src/security/cpf-vault.js';
import { startWorld, type World } from './helpers/world.js';

/** `npm run db:encrypt-cpf`: cifra o CPF legível de clientes antigos, uma vez só, sem perder o dado. */

let world: World;
const vault = new CpfVault('chave-de-teste-do-cpf-0123456789abcdef');
const PHONE = '5599988870001';

beforeAll(async () => {
  world = await startWorld();
  await world.reseed();
});

afterAll(async () => {
  await world.stop();
});

describe('encryptLegacyCpfs', () => {
  it('cifra o CPF legível, guarda a máscara e o hash, e a segunda rodada não mexe em nada', async () => {
    await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    await world.admin.query(
      `INSERT INTO customers (store_id, phone, name, cpf, cpf_last2)
       VALUES ($1, $2, 'Cliente Antigo', '52998224725', '25')`,
      [SEED_IDS.storeA, PHONE],
    );
    await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');

    expect(await encryptLegacyCpfs(world.admin, vault)).toBe(1);

    await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    const row = await world.admin.query<{ cpf: string; last2: string; hash: string }>(
      'SELECT cpf, cpf_last2 AS last2, cpf_key_hash AS hash FROM customers WHERE phone = $1',
      [PHONE],
    );
    await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');
    const stored = row.rows[0];
    expect(isSealed(stored?.cpf ?? '')).toBe(true);
    expect(stored?.cpf).not.toContain('52998224725');
    expect(stored?.last2).toBe('25');
    expect(stored?.hash).toBe(vault.keyHash('5299'));
    expect(vault.open(stored?.cpf ?? '')).toBe('52998224725');

    expect(await encryptLegacyCpfs(world.admin, vault)).toBe(0);
  });
});
