import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CpfKeyError,
  checkCpfKey,
  rotateCpfKey,
  runRotateCpfKey,
} from '../src/db/cpf-key-rotation.js';
import { SEED_IDS } from '../src/db/seed.js';
import { CpfVault } from '../src/security/cpf-vault.js';
import { startWorld, type World } from './helpers/world.js';

/** `npm run db:rotate-cpf-key`: troca a chave do CPF sem perder nenhum CPF. Postgres real. */

let world: World;
const keyA = 'chave-A-do-cpf-0123456789abcdef0123456789';
const keyB = 'chave-B-do-cpf-fedcba9876543210fedcba9876';
const keyC = 'chave-C-do-cpf-aaaaaaaaaaaaaaaaaaaaaaaaaa';
const vaultA = new CpfVault(keyA);
const vaultB = new CpfVault(keyB);
const vaultC = new CpfVault(keyC);

const CPFS = ['52998224725', '39053344705', '11144477735'];

beforeAll(async () => {
  world = await startWorld();
});

afterAll(async () => {
  await world.stop();
});

type Row = { phone: string; cpf: string | null; last2: string | null; hash: string | null };

async function stored(): Promise<Row[]> {
  await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
  const result = await world.admin.query<Row>(
    `SELECT phone, cpf, cpf_last2 AS last2, cpf_key_hash AS hash
       FROM customers WHERE phone LIKE '5588%' ORDER BY phone`,
  );
  await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');
  return result.rows;
}

/** Limpa os clientes e cria três com o CPF cifrado pela chave A (um sem CPF). */
beforeEach(async () => {
  await world.reseed();
  await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
  await world.admin.query("DELETE FROM customers WHERE phone LIKE '5588%'");
  // Os clientes do seed têm CPF cifrado com a chave de desenvolvimento: fora do cenário de rotação.
  await world.admin.query(
    'UPDATE customers SET cpf = NULL, cpf_last2 = NULL, cpf_key_hash = NULL, is_visitor = true',
  );
  for (const [index, cpf] of CPFS.entries()) {
    const sealed = vaultA.seal(cpf);
    await world.admin.query(
      `INSERT INTO customers (store_id, phone, name, cpf, cpf_last2, cpf_key_hash)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        SEED_IDS.storeA,
        `558800000000${String(index)}`,
        `Rotação ${String(index)}`,
        sealed.cipher,
        sealed.last2,
        sealed.keyHash,
      ],
    );
  }
  await world.admin.query(
    "INSERT INTO customers (store_id, phone, name) VALUES ($1, '5588000000099', 'Sem CPF')",
    [SEED_IDS.storeA],
  );
  await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');
});

describe('rotateCpfKey', () => {
  it('recifra tudo com a chave nova: a antiga deixa de abrir e o hash do consignador muda', async () => {
    const before = await stored();
    expect(before.map((r) => r.cpf !== null)).toEqual([true, true, true, false]);

    const result = await rotateCpfKey(world.admin, vaultA, vaultB);

    expect(result).toEqual({ rotated: 3, alreadyRotated: 0, plain: 0 });
    const after = await stored();
    for (const [index, row] of after.slice(0, 3).entries()) {
      const cpf = CPFS[index] ?? '';
      expect(vaultB.open(row.cpf ?? '')).toBe(cpf);
      expect(() => vaultA.open(row.cpf ?? '')).toThrow();
      expect(row.cpf).not.toBe(before[index]?.cpf);
      expect(row.cpf).not.toContain(cpf);
      expect(row.last2).toBe(cpf.slice(-2));
      expect(row.hash).toBe(vaultB.keyHash(cpf.slice(0, 4)));
      expect(row.hash).not.toBe(before[index]?.hash);
    }
    expect(after[3]).toMatchObject({ cpf: null, last2: null, hash: null });
    const forced = await world.admin.query<{ f: boolean }>(
      "SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'customers'",
    );
    expect(forced.rows[0]?.f).toBe(true);
  });

  it('é idempotente: a segunda rodada não muda nada e conta os que já estavam rotacionados', async () => {
    await rotateCpfKey(world.admin, vaultA, vaultB);
    const once = await stored();

    const again = await rotateCpfKey(world.admin, vaultA, vaultB);

    expect(again).toEqual({ rotated: 0, alreadyRotated: 3, plain: 0 });
    expect(await stored()).toEqual(once);
  });

  it('retoma depois de uma rotação parcial (parte já na chave nova)', async () => {
    const [first] = await stored();
    const sealed = vaultB.seal(CPFS[0] ?? '');
    await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    await world.admin.query('UPDATE customers SET cpf = $2, cpf_key_hash = $3 WHERE phone = $1', [
      first?.phone,
      sealed.cipher,
      sealed.keyHash,
    ]);
    await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');

    expect(await rotateCpfKey(world.admin, vaultA, vaultB)).toEqual({
      rotated: 2,
      alreadyRotated: 1,
      plain: 0,
    });
  });

  it('um CPF que nenhuma chave abre desfaz tudo, sem vazar o CPF, e o RLS continua forçado', async () => {
    const before = await stored();
    const alien = vaultC.seal('00000000191');
    await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    await world.admin.query('UPDATE customers SET cpf = $2 WHERE phone = $1', [
      '5588000000002',
      alien.cipher,
    ]);
    await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');
    const snapshot = await stored();

    const failure = await rotateCpfKey(world.admin, vaultA, vaultB).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(CpfKeyError);
    expect((failure as Error).message).toMatch(/não abre com nenhuma das duas chaves/);
    expect((failure as Error).message).not.toContain('00000000191');
    expect(await stored()).toEqual(snapshot);
    expect(snapshot[0]?.cpf).toBe(before[0]?.cpf);
    const forced = await world.admin.query<{ f: boolean }>(
      "SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'customers'",
    );
    expect(forced.rows[0]?.f).toBe(true);
  });

  it('recusa CPF ainda legível: rode db:encrypt-cpf antes', async () => {
    await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    await world.admin.query(
      "UPDATE customers SET cpf = '52998224725' WHERE phone = '5588000000001'",
    );
    await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');
    const snapshot = await stored();

    await expect(rotateCpfKey(world.admin, vaultA, vaultB)).rejects.toThrow(/db:encrypt-cpf/);
    expect(await stored()).toEqual(snapshot);
  });
});

describe('CPF do usuário (users.cpf, migration 0027)', () => {
  async function sealUser(vault: CpfVault, cpf: string): Promise<void> {
    const sealed = vault.seal(cpf);
    await world.admin.query('UPDATE users SET cpf = $2, cpf_last2 = $3 WHERE id = $1', [
      SEED_IDS.userOwner,
      sealed.cipher,
      sealed.last2,
    ]);
  }
  const userCpf = async () =>
    (
      await world.admin.query<{ cpf: string }>('SELECT cpf FROM users WHERE id = $1', [
        SEED_IDS.userOwner,
      ])
    ).rows[0]?.cpf ?? '';

  it('rotaciona também o CPF do perfil, na mesma transação', async () => {
    await sealUser(vaultA, '12345678909');

    const result = await rotateCpfKey(world.admin, vaultA, vaultB);

    expect(result).toEqual({ rotated: 4, alreadyRotated: 0, plain: 0 });
    const sealed = await userCpf();
    expect(vaultB.open(sealed)).toBe('12345678909');
    expect(() => vaultA.open(sealed)).toThrow();
    expect(await checkCpfKey(world.admin, vaultB)).toEqual({ ok: 4, failed: 0 });
    expect(await checkCpfKey(world.admin, vaultA)).toEqual({ ok: 0, failed: 4 });
  });

  it('CPF de usuário que nenhuma chave abre desfaz também a rotação dos clientes', async () => {
    await sealUser(vaultC, '12345678909');
    const before = await stored();

    await expect(rotateCpfKey(world.admin, vaultA, vaultB)).rejects.toThrow(/usuário/);

    expect(await stored()).toEqual(before);
    expect(vaultC.open(await userCpf())).toBe('12345678909');
  });
});

describe('checkCpfKey (usado pelo restore.sh)', () => {
  it('confere que todo CPF abre com a chave e que a máscara e o hash batem', async () => {
    expect(await checkCpfKey(world.admin, vaultA)).toEqual({ ok: 3, failed: 0 });
    expect(await checkCpfKey(world.admin, vaultB)).toEqual({ ok: 0, failed: 3 });
    await rotateCpfKey(world.admin, vaultA, vaultB);
    expect(await checkCpfKey(world.admin, vaultB)).toEqual({ ok: 3, failed: 0 });
    expect(await checkCpfKey(world.admin, vaultA)).toEqual({ ok: 0, failed: 3 });

    // não escreve nada e deixa o RLS forçado
    const forced = await world.admin.query<{ f: boolean }>(
      "SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'customers'",
    );
    expect(forced.rows[0]?.f).toBe(true);
  });

  it('acusa hash fora de sincronia (restauração com chave errada ou dado adulterado)', async () => {
    await world.admin.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    await world.admin.query(
      "UPDATE customers SET cpf_key_hash = repeat('0', 64) WHERE phone = '5588000000000'",
    );
    await world.admin.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');

    expect(await checkCpfKey(world.admin, vaultA)).toEqual({ ok: 2, failed: 1 });
  });
});

describe('runRotateCpfKey (variáveis de ambiente)', () => {
  const base = { MIGRATION_DATABASE_URL: 'postgresql://x:y@127.0.0.1:1/z' };

  it('exige as duas chaves, longas, e diferentes, antes de abrir conexão', async () => {
    await expect(runRotateCpfKey(base, [])).rejects.toThrow('CPF_ENCRYPTION_KEY');
    await expect(runRotateCpfKey({ ...base, CPF_ENCRYPTION_KEY: 'curta' }, [])).rejects.toThrow(
      'mínimo',
    );
    await expect(runRotateCpfKey({ ...base, CPF_ENCRYPTION_KEY: keyB }, [])).rejects.toThrow(
      'CPF_ENCRYPTION_KEY_OLD',
    );
    await expect(
      runRotateCpfKey({ ...base, CPF_ENCRYPTION_KEY: keyB, CPF_ENCRYPTION_KEY_OLD: keyB }, []),
    ).rejects.toThrow('iguais');
    await expect(runRotateCpfKey({ CPF_ENCRYPTION_KEY: keyB }, ['--check'])).rejects.toThrow(
      'MIGRATION_DATABASE_URL',
    );
  });
});
