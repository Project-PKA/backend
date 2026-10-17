// Cria (ou promove) o administrador da plataforma. É o ÚNICO caminho para isso:
// não existe rota nem tela (ADR 0012). Roda com o papel dono do schema.
//
//   npm run db:create-admin -- pessoa@exemplo.com "Nome da Pessoa"
import { createPool } from './client.js';

function isPlausibleEmail(value: string): boolean {
  const at = value.indexOf('@');
  return at > 0 && value.indexOf('.', at) > at + 1 && !value.includes(' ') && value.length <= 254;
}

const [rawEmail, name] = process.argv.slice(2);
const email = rawEmail?.trim().toLowerCase();
if (email === undefined || !isPlausibleEmail(email)) {
  console.error('Uso: db:create-admin -- <email> ["Nome"]');
  process.exit(2);
}

const url = process.env['MIGRATION_DATABASE_URL'] ?? process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  throw new Error('Defina MIGRATION_DATABASE_URL (ou DATABASE_URL) com o usuário dono do schema');
}

const pool = createPool(url);
try {
  await pool.query(
    `INSERT INTO users (email, name, status, is_platform_admin)
     VALUES ($1, $2, 'ACTIVE', true)
     ON CONFLICT (email) DO UPDATE
       SET status = 'ACTIVE', is_platform_admin = true,
           name = coalesce(users.name, excluded.name)`,
    [email, name ?? null],
  );
  console.log(`Administrador da plataforma pronto: ${email}`);
} finally {
  await pool.end();
}
