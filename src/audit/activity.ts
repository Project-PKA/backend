import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import type { Db, Tx } from '../db/context.js';
import { withContext } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';

const { activityLog, storeMembers, users } = schema;

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
  /**
   * Quem agiu, se ainda é da equipe da loja. `null` para ação do sistema, para quem saiu da equipe
   * e para o administrador da plataforma (o proprietário não vê e-mail de quem não é mais da equipe).
   */
  actor: { id: string; name: string | null; email: string } | null;
}

export interface ActivityQuery {
  limit: number;
  cursor?: string;
  actorUserId?: string;
  /** Ação exata (`card.created`) ou prefixo terminado em ponto (`card.`). */
  action?: string;
}

function actionFilter(action: string | undefined): SQL | undefined {
  if (action === undefined) return undefined;
  return action.endsWith('.')
    ? sql`starts_with(${activityLog.action}, ${action})`
    : eq(activityLog.action, action);
}

/**
 * Lê o log da loja, do mais novo para o mais antigo. Só o proprietário enxerga:
 * o próprio banco confere o papel (política `activity_log_select`).
 */
export async function listActivity(
  db: Db,
  context: { storeId: string; userId: string },
  query: ActivityQuery,
): Promise<Page<ActivityEntry> | 'INVALID_CURSOR'> {
  const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
  if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';

  const rows = await withContext(db, context, (tx) =>
    tx
      .select({ entry: activityLog, memberUserId: users.id, name: users.name, email: users.email })
      .from(activityLog)
      .leftJoin(
        storeMembers,
        and(
          eq(storeMembers.userId, activityLog.actorUserId),
          eq(storeMembers.storeId, context.storeId),
        ),
      )
      .leftJoin(users, eq(users.id, storeMembers.userId))
      .where(
        and(
          eq(activityLog.storeId, context.storeId),
          query.actorUserId === undefined
            ? undefined
            : eq(activityLog.actorUserId, query.actorUserId),
          actionFilter(query.action),
          position === null
            ? undefined
            : sql`(${activityLog.createdAt}, ${activityLog.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
        ),
      )
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(query.limit + 1),
  );
  return toPage(
    rows.map(({ entry: row, memberUserId, name, email }) => ({
      id: row.id,
      createdAt: row.createdAt,
      actorUserId: row.actorUserId,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      details: row.details,
      actor: memberUserId === null || email === null ? null : { id: memberUserId, name, email },
    })),
    query.limit,
  );
}
