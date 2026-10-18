import pg from 'pg';

export function createPool(databaseUrl: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  // Sem ouvinte, o erro de uma conexão OCIOSA (banco reiniciado, container parado) derruba o
  // processo inteiro com "Unhandled error". O pool descarta a conexão e abre outra na próxima
  // consulta; aqui só registramos, sem a mensagem (pode trazer host e usuário).
  pool.on('error', (error: Error & { code?: string }) => {
    console.error(
      JSON.stringify({
        level: 'warn',
        message: 'conexão ociosa do banco encerrada',
        code: error.code ?? 'UNKNOWN',
      }),
    );
  });
  return pool;
}

/** Resolve se o banco responde a uma consulta trivial; rejeita se não. */
export async function checkDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('SELECT 1');
}
