import type pg from 'pg';

import type { CpfVault } from '../security/cpf-vault.js';

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
