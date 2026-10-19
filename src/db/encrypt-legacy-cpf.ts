import type pg from 'pg';

import { CpfVault } from '../security/cpf-vault.js';
import { createPool } from './client.js';

/**
 * Cifra os CPFs que ainda estão legíveis (clientes anteriores à migration 0024) e preenche
 * `cpf_last2` e `cpf_key_hash`. Roda com o dono do schema. Pode rodar mais de uma vez: só mexe no
 * que ainda está legível. Devolve quantos foram cifrados.
 */
export async function encryptLegacyCpfs(pool: pg.Pool, vault: CpfVault): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A tabela tem FORCE RLS e a política vale só para `app_runtime`: o dono solta o FORCE na transação.
    await client.query('ALTER TABLE customers NO FORCE ROW LEVEL SECURITY');
    const legacy = await client.query<{ id: string; cpf: string }>(
      "SELECT id, cpf FROM customers WHERE cpf ~ '^[0-9]{11}$'",
    );
    for (const row of legacy.rows) {
      const sealed = vault.seal(row.cpf);
      await client.query(
        'UPDATE customers SET cpf = $2, cpf_last2 = $3, cpf_key_hash = $4 WHERE id = $1',
        [row.id, sealed.cipher, sealed.last2, sealed.keyHash],
      );
    }
    await client.query('ALTER TABLE customers FORCE ROW LEVEL SECURITY');
    await client.query('COMMIT');
    return legacy.rows.length;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** O que o `npm run db:encrypt-cpf` faz: lê o ambiente, conecta como dono do schema e cifra. */
export async function runEncryptCpf(env: NodeJS.ProcessEnv): Promise<string> {
  const url = env['MIGRATION_DATABASE_URL'] ?? env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('Defina MIGRATION_DATABASE_URL (ou DATABASE_URL) com o usuário dono do schema');
  }
  const key = env['CPF_ENCRYPTION_KEY'];
  if (key === undefined || key.length < 32) {
    throw new Error('Defina CPF_ENCRYPTION_KEY (mínimo de 32 caracteres), a mesma da API');
  }
  const pool = createPool(url);
  try {
    return `${String(await encryptLegacyCpfs(pool, new CpfVault(key)))} CPF(s) cifrado(s).`;
  } finally {
    await pool.end();
  }
}
