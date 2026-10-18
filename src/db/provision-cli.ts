// Cria (ou troca a senha d)o papel de LOGIN da API em qualquer ambiente, inclusive homolog e prod:
//
//   MIGRATION_DATABASE_URL=... DB_APP_PASSWORD=... node dist/db/provision-cli.js
//
// Com `DB_BOT_PASSWORD` também cria o login do bot de WhatsApp (`DB_BOT_USER`, padrão bot_api) no
// grupo `bot_runtime`. Roda com o papel DONO do schema, depois das migrations (que criam o grupo `app_runtime`), e é
// idempotente. A senha vem do ambiente (secret `DB_APP_PASSWORD`), nunca de argumento de linha de
// comando (apareceria na lista de processos) e nunca é impressa.
import { createPool } from './client.js';
import { provisionLoginRole } from './roles.js';

const url = process.env['MIGRATION_DATABASE_URL'];
if (url === undefined || url === '') {
  throw new Error('Defina MIGRATION_DATABASE_URL com o usuário dono do schema');
}

const name = process.env['DB_APP_USER'] ?? 'app_api';
if (!/^[a-z][a-z0-9_]{2,30}$/.test(name)) {
  throw new Error('DB_APP_USER inválido: use letras minúsculas, números e _ (3 a 31 caracteres)');
}

const password = process.env['DB_APP_PASSWORD'] ?? '';
if (password.length < 24) {
  throw new Error('DB_APP_PASSWORD precisa ter pelo menos 24 caracteres');
}

const botName = process.env['DB_BOT_USER'] ?? 'bot_api';
if (!/^[a-z][a-z0-9_]{2,30}$/.test(botName)) {
  throw new Error('DB_BOT_USER inválido: use letras minúsculas, números e _ (3 a 31 caracteres)');
}
const botPassword = process.env['DB_BOT_PASSWORD'] ?? '';
if (botPassword !== '' && botPassword.length < 24) {
  throw new Error('DB_BOT_PASSWORD precisa ter pelo menos 24 caracteres');
}

async function ensureNoPrivilege(pool: ReturnType<typeof createPool>, role: string): Promise<void> {
  const check = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1',
    [role],
  );
  const found = check.rows[0];
  if (found === undefined || found.rolbypassrls || found.rolsuper) {
    throw new Error(`o papel "${role}" ficou com privilégio demais (BYPASSRLS ou superusuário)`);
  }
}

const pool = createPool(url);
try {
  await provisionLoginRole(pool, { name, password });
  await ensureNoPrivilege(pool, name);
  console.log(`Papel de login "${name}" pronto (grupo app_runtime, sem BYPASSRLS).`);
  if (botPassword !== '') {
    await provisionLoginRole(pool, { name: botName, password: botPassword, group: 'bot_runtime' });
    await ensureNoPrivilege(pool, botName);
    console.log(`Papel de login "${botName}" pronto (grupo bot_runtime, sem BYPASSRLS).`);
  }
} finally {
  await pool.end();
}
