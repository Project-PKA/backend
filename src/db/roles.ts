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
