import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encryptLegacyCpfs, runEncryptCpf } from '../src/db/encrypt-legacy-cpf.js';
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

  it('desfaz tudo se a cifra falhar no meio e o RLS continua forçado', async () => {
    await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    await world.admin.query(
      `INSERT INTO customers (store_id, phone, name, cpf, cpf_last2)
       VALUES ($1, '5599988870002', 'Outro Antigo', '39053344705', '05')`,
      [SEED_IDS.storeA],
    );
    await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');
    const broken = {
      seal: () => {
        throw new Error('falha de teste');
      },
    };

    await expect(encryptLegacyCpfs(world.admin, broken as unknown as CpfVault)).rejects.toThrow(
      'falha de teste',
    );

    const forced = await world.admin.query<{ f: boolean }>(
      "SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'customers'",
    );
    expect(forced.rows[0]?.f).toBe(true);
    // Ainda legível (nada foi cifrado pela metade); o próximo `db:encrypt-cpf` termina o serviço.
    await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    const left = await world.admin.query("SELECT cpf FROM customers WHERE phone = '5599988870002'");
    await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');
    expect(left.rows[0]).toEqual({ cpf: '39053344705' });
  });
});

describe('runEncryptCpf (o script)', () => {
  const key = 'chave-de-teste-do-cpf-0123456789abcdef';

  it('exige o banco do dono e uma chave de 32 caracteres', async () => {
    await expect(runEncryptCpf({ CPF_ENCRYPTION_KEY: key })).rejects.toThrow(
      'MIGRATION_DATABASE_URL',
    );
    await expect(
      runEncryptCpf({ MIGRATION_DATABASE_URL: world.database.uri, CPF_ENCRYPTION_KEY: 'curta' }),
    ).rejects.toThrow('CPF_ENCRYPTION_KEY');
  });

  it('conecta, cifra e informa quantos', async () => {
    const message = await runEncryptCpf({
      MIGRATION_DATABASE_URL: world.database.uri,
      CPF_ENCRYPTION_KEY: key,
    });
    expect(message).toMatch(/^\d+ CPF\(s\) cifrado\(s\)\.$/);
  });
});
