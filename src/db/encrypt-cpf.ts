import { createPool } from './client.js';
import { CpfVault } from '../security/cpf-vault.js';

/**
 * Cifra os CPFs que ainda estão legíveis no banco (clientes anteriores à migration 0024) e preenche
 * `cpf_last2` e `cpf_key_hash`. Roda com o dono do schema e a mesma `CPF_ENCRYPTION_KEY` da API.
 * Pode rodar mais de uma vez: só mexe no que ainda está legível.
 */
const url = process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  throw new Error('Defina MIGRATION_DATABASE_URL (ou DATABASE_URL) com o usuário dono do schema');
}
const key = process.env['CPF_ENCRYPTION_KEY'];
if (key === undefined || key.length < 32) {
  throw new Error('Defina CPF_ENCRYPTION_KEY (mínimo de 32 caracteres), a mesma da API');
}

const vault = new CpfVault(key);
const pool = createPool(url);
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
  console.log(`${String(legacy.rowCount ?? 0)} CPF(s) cifrado(s).`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
