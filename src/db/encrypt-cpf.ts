import { CpfVault } from '../security/cpf-vault.js';
import { createPool } from './client.js';
import { encryptLegacyCpfs } from './encrypt-legacy-cpf.js';

/**
 * Cifra os CPFs que ainda estão legíveis no banco (clientes anteriores à migration 0024). Roda com o
 * dono do schema e a mesma `CPF_ENCRYPTION_KEY` da API. A lógica está em `encrypt-legacy-cpf.ts`.
 */
const url = process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  throw new Error('Defina MIGRATION_DATABASE_URL (ou DATABASE_URL) com o usuário dono do schema');
}
const key = process.env['CPF_ENCRYPTION_KEY'];
if (key === undefined || key.length < 32) {
  throw new Error('Defina CPF_ENCRYPTION_KEY (mínimo de 32 caracteres), a mesma da API');
}

const pool = createPool(url);
try {
  console.log(`${String(await encryptLegacyCpfs(pool, new CpfVault(key)))} CPF(s) cifrado(s).`);
} finally {
  await pool.end();
}
