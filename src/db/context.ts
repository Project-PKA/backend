import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';

import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Contexto de uma transação para o RLS (ADR 0011). Sem `storeId` as tabelas de
 * loja não devolvem linha nenhuma. O Backend define isto; o banco aplica.
 */
export interface DbContext {
  storeId?: string;
  userId?: string;
  isPlatformAdmin?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema });
}

function assertUuid(name: string, value: string | undefined): string {
  if (value === undefined) return '';
  if (!UUID.test(value)) throw new Error(`${name} inválido para o contexto do banco`);
  return value;
}

/**
 * Abre uma transação e define o contexto com `set_config(..., true)`: o valor
 * vale só até o fim da transação, então uma conexão reaproveitada pelo pool
 * nunca carrega o contexto de outra requisição.
 */
export async function withContext<T>(
  db: Db,
  context: DbContext,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const storeId = assertUuid('storeId', context.storeId);
  const userId = assertUuid('userId', context.userId);
  const isAdmin = context.isPlatformAdmin === true ? 'true' : '';
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('app.store_id', ${storeId}, true),
                 set_config('app.user_id', ${userId}, true),
                 set_config('app.is_platform_admin', ${isAdmin}, true)`,
    );
    return work(tx);
  });
}
