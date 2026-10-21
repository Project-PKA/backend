import type pg from 'pg';

import { CpfVault, isSealed } from '../security/cpf-vault.js';
import { createPool } from './client.js';

/**
 * Rotação da chave do CPF (ADR 0019; shared#47). Roda com o dono do schema, com a API parada ou já
 * apontando para a chave nova: decifra cada CPF com a chave antiga e recifra com a nova (IV novo),
 * e recalcula `cpf_key_hash` (a chave do consignador sai da mesma chave). Tudo numa transação que
 * trava a tabela de clientes; qualquer CPF que nenhuma das duas chaves abre desfaz tudo.
 *
 * Idempotente: o CPF que já abre com a chave nova é contado como "já rotacionado" e não muda. Nada
 * aqui imprime CPF nem chave; as mensagens trazem só contagens e o id da linha com problema.
 */
export interface RotationResult {
  rotated: number;
  alreadyRotated: number;
  /** CPF ainda legível (anterior à migration 0024): rode `db:encrypt-cpf` antes. */
  plain: number;
}

export class CpfKeyError extends Error {}

/**
 * Onde há CPF cifrado. `customers` tem RLS forçado (o dono solta o FORCE na transação) e a chave do
 * consignador (`cpf_key_hash`); `users` (perfil, migration 0027) não tem nenhum dos dois.
 */
const TABLES = [
  { name: 'customers', label: 'cliente', hash: true, rls: true },
  { name: 'users', label: 'usuário', hash: false, rls: false },
] as const;

type Target = (typeof TABLES)[number];

async function rotateTable(
  client: pg.PoolClient,
  target: Target,
  oldVault: CpfVault,
  newVault: CpfVault,
  result: RotationResult,
): Promise<void> {
  if (target.rls) await client.query(`ALTER TABLE ${target.name} NO FORCE ROW LEVEL SECURITY`);
  await client.query(`LOCK TABLE ${target.name} IN SHARE ROW EXCLUSIVE MODE`);
  const rows = await client.query<{ id: string; cpf: string }>(
    `SELECT id, cpf FROM ${target.name} WHERE cpf IS NOT NULL ORDER BY id`,
  );
  for (const row of rows.rows) {
    if (!isSealed(row.cpf)) {
      result.plain += 1;
      continue;
    }
    if (tryOpen(newVault, row.cpf) !== null) {
      result.alreadyRotated += 1;
      continue;
    }
    const cpf = tryOpen(oldVault, row.cpf);
    if (cpf === null) {
      throw new CpfKeyError(
        `o CPF do ${target.label} ${row.id} não abre com nenhuma das duas chaves`,
      );
    }
    const sealed = newVault.seal(cpf);
    if (target.hash) {
      await client.query(
        `UPDATE ${target.name} SET cpf = $2, cpf_last2 = $3, cpf_key_hash = $4 WHERE id = $1`,
        [row.id, sealed.cipher, sealed.last2, sealed.keyHash],
      );
    } else {
      await client.query(`UPDATE ${target.name} SET cpf = $2, cpf_last2 = $3 WHERE id = $1`, [
        row.id,
        sealed.cipher,
        sealed.last2,
      ]);
    }
    result.rotated += 1;
  }
  if (target.rls) await client.query(`ALTER TABLE ${target.name} FORCE ROW LEVEL SECURITY`);
}

export async function rotateCpfKey(
  pool: pg.Pool,
  oldVault: CpfVault,
  newVault: CpfVault,
): Promise<RotationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result: RotationResult = { rotated: 0, alreadyRotated: 0, plain: 0 };
    for (const target of TABLES) await rotateTable(client, target, oldVault, newVault, result);
    if (result.plain > 0) {
      throw new CpfKeyError(
        `${String(result.plain)} CPF(s) ainda legível(is): rode db:encrypt-cpf antes de rotacionar`,
      );
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export interface CheckResult {
  ok: number;
  failed: number;
}

/**
 * Confere (sem escrever) que todo CPF cifrado, de clientes e de usuários, abre com a chave dada e que
 * `cpf_last2` (e, nos clientes, `cpf_key_hash`) batem. É o teste do `restore.sh`: backup restaurado
 * com a chave errada ou perdida aparece aqui, antes do desastre.
 */
export async function checkCpfKey(pool: pg.Pool, vault: CpfVault): Promise<CheckResult> {
  const client = await pool.connect();
  try {
    // Só leitura: o NO FORCE (a política vale só para `app_runtime`) é desfeito pelo ROLLBACK.
    await client.query('BEGIN');
    await client.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    const result: CheckResult = { ok: 0, failed: 0 };
    for (const target of TABLES) {
      const rows = await client.query<{
        cpf: string;
        cpf_last2: string | null;
        cpf_key_hash: string | null;
      }>(
        `SELECT cpf, cpf_last2, ${target.hash ? 'cpf_key_hash' : 'NULL::text AS cpf_key_hash'}
           FROM ${target.name} WHERE cpf IS NOT NULL`,
      );
      for (const row of rows.rows) {
        const cpf = isSealed(row.cpf) ? tryOpen(vault, row.cpf) : null;
        const consistent =
          cpf !== null &&
          cpf.slice(-2) === row.cpf_last2 &&
          (!target.hash || vault.keyHash(cpf.slice(0, 4)) === row.cpf_key_hash);
        if (consistent) result.ok += 1;
        else result.failed += 1;
      }
    }
    await client.query('ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function tryOpen(vault: CpfVault, sealed: string): string | null {
  try {
    return vault.open(sealed);
  } catch {
    return null;
  }
}

const MIN_KEY_LENGTH = 32;

function requiredKey(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value.length < MIN_KEY_LENGTH) {
    throw new CpfKeyError(`Defina ${name} (mínimo de ${String(MIN_KEY_LENGTH)} caracteres)`);
  }
  return value;
}

function ownerUrl(env: NodeJS.ProcessEnv): string {
  const url = env['MIGRATION_DATABASE_URL'] ?? env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new CpfKeyError('Defina MIGRATION_DATABASE_URL com o usuário dono do schema');
  }
  return url;
}

/**
 * O que o `npm run db:rotate-cpf-key` faz. Sem argumento: rotaciona (`CPF_ENCRYPTION_KEY_OLD` →
 * `CPF_ENCRYPTION_KEY`). Com `--check`: só confere `CPF_ENCRYPTION_KEY` contra o banco (usado pelo
 * `deploy/restore.sh`); devolve código de saída 1 se algum CPF não abrir.
 */
export async function runRotateCpfKey(
  env: NodeJS.ProcessEnv,
  args: string[],
): Promise<{ message: string; exitCode: number }> {
  const newKey = requiredKey(env, 'CPF_ENCRYPTION_KEY');
  const pool = createPool(ownerUrl(env));
  try {
    if (args.includes('--check')) {
      const { ok, failed } = await checkCpfKey(pool, new CpfVault(newKey));
      const message = `CPF: ${String(ok)} abrem com a chave, ${String(failed)} não abrem.`;
      return { message, exitCode: failed === 0 ? 0 : 1 };
    }
    const oldKey = requiredKey(env, 'CPF_ENCRYPTION_KEY_OLD');
    if (oldKey === newKey) {
      throw new CpfKeyError(
        'CPF_ENCRYPTION_KEY_OLD e CPF_ENCRYPTION_KEY são iguais: nada a rotacionar',
      );
    }
    const result = await rotateCpfKey(pool, new CpfVault(oldKey), new CpfVault(newKey));
    return {
      message: `${String(result.rotated)} CPF(s) recifrado(s), ${String(result.alreadyRotated)} já estava(m) com a chave nova.`,
      exitCode: 0,
    };
  } finally {
    await pool.end();
  }
}
