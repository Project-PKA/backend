import { and, desc, eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '../db/context.js';
import { withContext } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';

const { activityLog } = schema;

export interface ActivityInput {
  storeId: string;
  /** Quem agiu. `null` para ações do sistema. */
  actorUserId: string | null;
  /** `objeto.acao`, em minúsculas. Ex.: `member.removed`. */
  action: string;
  targetType?: string;
  targetId?: string;
  /** Só identificadores e valores técnicos. Nunca e-mail, telefone ou CPF. */
  details?: Record<string, unknown>;
}

/**
 * Registra uma ação **dentro da transação que a executa**: se a ação falhar e
 * for desfeita, o registro some junto; se o registro falhar, a ação não vale.
 * A transação precisa ter o contexto da loja (RLS).
 */
export async function recordActivity(tx: Tx, input: ActivityInput): Promise<void> {
  await tx.insert(activityLog).values({
    storeId: input.storeId,
    actorUserId: input.actorUserId,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    details: input.details ?? {},
  });
}

export interface ActivityEntry {
  id: string;
  createdAt: Date;
  actorUserId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
}

/**
 * Lê o log da loja, do mais novo para o mais antigo. Só o proprietário enxerga:
 * o próprio banco confere o papel (política `activity_log_select`).
 */
export async function listActivity(
  db: Db,
  context: { storeId: string; userId: string },
  query: { limit: number; cursor?: string },
): Promise<Page<ActivityEntry> | 'INVALID_CURSOR'> {
  const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';

  const rows = await withContext(db, context, (tx) =>
    tx
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.storeId, context.storeId),
          position === null
            ? undefined
            : sql`(${activityLog.createdAt}, ${activityLog.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
        ),
      )
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(query.limit + 1),
  );
  return toPage(
    rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      actorUserId: row.actorUserId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      details: row.details,
    })),
    query.limit,
  );
}
