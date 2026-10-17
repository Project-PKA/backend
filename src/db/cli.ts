import path from 'node:path';

import { createPool } from './client.js';
import { createMigration, migrateDown, migrateUp, migrationStatus } from './migrator.js';

const migrationsDir = path.resolve(process.env['MIGRATIONS_DIR'] ?? 'migrations');
const [command, arg] = process.argv.slice(2);

function usage(): never {
  console.error('Uso: cli.ts <up | down [passos] | status | new <nome-em-kebab-case>>');
  process.exit(2);
}

async function withPool<T>(work: (pool: ReturnType<typeof createPool>) => Promise<T>): Promise<T> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    throw new Error('Variável de ambiente obrigatória ausente: DATABASE_URL');
  }
  const pool = createPool(url);
  try {
    return await work(pool);
  } finally {
    await pool.end();
  }
}

switch (command) {
  case 'up': {
    const done = await withPool((pool) => migrateUp(pool, migrationsDir));
    console.log(done.length === 0 ? 'Nada a aplicar.' : `Aplicadas: ${done.join(', ')}`);
    break;
  }
  case 'down': {
    const steps = arg === undefined ? 1 : Number(arg);
    if (!Number.isInteger(steps) || steps < 1) usage();
    const done = await withPool((pool) => migrateDown(pool, migrationsDir, steps));
    console.log(done.length === 0 ? 'Nada a reverter.' : `Revertidas: ${done.join(', ')}`);
    break;
  }
  case 'status': {
    const rows = await withPool((pool) => migrationStatus(pool, migrationsDir));
    for (const row of rows) console.log(`${row.applied ? 'aplicada ' : 'pendente '} ${row.id}`);
    break;
  }
  case 'new': {
    if (arg === undefined) usage();
    console.log(`Criada: migrations/${await createMigration(migrationsDir, arg)}`);
    break;
  }
  default:
    usage();
}
