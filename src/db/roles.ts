import type pg from 'pg';

export interface LoginRoleOptions {
  name: string;
  password: string;
  /** Grupo que concede os privilégios. Padrão: o do Backend em execução. */
  group?: string;
}

/**
 * Cria (ou atualiza a senha de) um papel de LOGIN dentro de um grupo sem
 * `BYPASSRLS`. Roda com o papel dono/migração, nunca com o `app_runtime`.
 * Os identificadores e a senha passam por `format(%I/%L)`, então não há
 * concatenação de entrada em SQL.
 */
export async function provisionLoginRole(pool: pg.Pool, options: LoginRoleOptions): Promise<void> {
  const group = options.group ?? 'app_runtime';
  const exists = await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [options.name]);
  const template =
    exists.rowCount === 0
      ? 'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE IN ROLE %I'
      : 'ALTER ROLE %I PASSWORD %L';
  const args =
    exists.rowCount === 0
      ? [options.name, options.password, group]
      : [options.name, options.password];
  const placeholders = args.map((_, i) => `$${i + 2}::text`).join(', ');
  const built = await pool.query<{ sql: string }>(`SELECT format($1, ${placeholders}) AS sql`, [
    template,
    ...args,
  ]);
  const statement = built.rows[0]?.sql;
  if (statement === undefined) throw new Error('Falha ao montar o comando do papel');
  await pool.query(statement);
}

export interface LoginCredentials {
  name: string;
  password: string;
}

/** Falha se o papel tiver superusuário ou `BYPASSRLS`: nenhum login de runtime pode ter. */
export async function assertNoPrivilege(pool: pg.Pool, role: string): Promise<void> {
  const check = await pool.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1',
    [role],
  );
  const found = check.rows[0];
  if (found === undefined || found.rolbypassrls || found.rolsuper) {
    throw new Error(`o papel "${role}" ficou com privilégio demais (BYPASSRLS ou superusuário)`);
  }
}

/**
 * Login do bot de WhatsApp a partir do ambiente (`DB_BOT_USER`, `DB_BOT_PASSWORD`). Sem senha = sem
 * bot (`null`). Valida nome e tamanho da senha antes de tocar no banco.
 */
export function botLoginFromEnv(env: NodeJS.ProcessEnv): LoginCredentials | null {
  const password = env['DB_BOT_PASSWORD'] ?? '';
  if (password === '') return null;
  const name = env['DB_BOT_USER'] ?? 'bot_api';
  if (!/^[a-z][a-z0-9_]{2,30}$/.test(name)) {
    throw new Error('DB_BOT_USER inválido: use letras minúsculas, números e _ (3 a 31 caracteres)');
  }
  if (password.length < 24) {
    throw new Error('DB_BOT_PASSWORD precisa ter pelo menos 24 caracteres');
  }
  return { name, password };
}

/**
 * Cria ou atualiza os logins de runtime e confere que nenhum ficou com privilégio demais: o da API
 * (grupo `app_runtime`) e, se houver, o do bot (grupo `bot_runtime`). Devolve o que foi feito.
 */
export async function provisionRuntimeRoles(
  pool: pg.Pool,
  logins: { app: LoginCredentials; bot: LoginCredentials | null },
): Promise<string[]> {
  const done: string[] = [];
  await provisionLoginRole(pool, logins.app);
  await assertNoPrivilege(pool, logins.app.name);
  done.push(`Papel de login "${logins.app.name}" pronto (grupo app_runtime, sem BYPASSRLS).`);
  if (logins.bot !== null) {
    await provisionLoginRole(pool, { ...logins.bot, group: 'bot_runtime' });
    await assertNoPrivilege(pool, logins.bot.name);
    done.push(`Papel de login "${logins.bot.name}" pronto (grupo bot_runtime, sem BYPASSRLS).`);
  }
  return done;
}
