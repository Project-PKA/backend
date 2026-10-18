// Roda o sync do catálogo uma vez, na mão (primeira carga ou quando o job noturno falhou):
//
//   npm run catalog:sync
import { loadEnv } from '../config/env.js';
import { createPool } from '../db/client.js';
import { createDb } from '../db/context.js';
import { syncCatalog } from './sync.js';
import { createTcgdexClient } from './tcgdex.js';

const env = loadEnv();
const pool = createPool(env.databaseUrl);
try {
  const summary = await syncCatalog({
    db: createDb(pool),
    client: createTcgdexClient(),
    languages: env.catalogLanguages,
    log: {
      info: (o, m) => {
        console.log(m, o);
      },
      warn: (o, m) => {
        console.error(m, o);
      },
    },
  });
  console.log('Catálogo sincronizado:', summary);
} finally {
  await pool.end();
}
