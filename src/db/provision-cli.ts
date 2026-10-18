// Cria (ou troca a senha d)o papel de LOGIN da API em qualquer ambiente, inclusive homolog e prod:
//
//   MIGRATION_DATABASE_URL=... DB_APP_PASSWORD=... node dist/db/provision-cli.js
//
// Com `DB_BOT_PASSWORD` também cria o login do bot de WhatsApp (`DB_BOT_USER`, padrão bot_api), no
// grupo `bot_runtime`. Roda com o papel DONO do schema, depois das migrations (que criam o grupo `app_runtime`), e é
// idempotente. A senha vem do ambiente (secret `DB_APP_PASSWORD`), nunca de argumento de linha de
// comando (apareceria na lista de processos) e nunca é impressa.
import { createPool } from './client.js';
import { botLoginFromEnv, provisionRuntimeRoles } from './roles.js';

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

const bot = botLoginFromEnv(process.env);

const pool = createPool(url);
try {
  const done = await provisionRuntimeRoles(pool, { app: { name, password }, bot });
  console.log(done.join('\n'));
} finally {
  await pool.end();
}
