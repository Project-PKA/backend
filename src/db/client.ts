import pg from 'pg';

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** Resolve se o banco responde a uma consulta trivial; rejeita se não. */
export async function checkDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
