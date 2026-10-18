import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { withContext, type Db, type Tx } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';

const { notifications, notificationReads } = schema;

interface Context {
  storeId: string;
  userId: string;
}

export interface NotificationView {
  id: string;
  kind: string;
  data: Record<string, unknown>;
  read: boolean;
  createdAt: Date;
}

/**
 * Registra um aviso da loja dentro da transação que o gerou. O texto é do frontend: aqui só vão o
 * código (`POLL_CEILING_REACHED`...) e ids. Nunca nome, telefone, CPF ou texto de terceiros.
 */
export async function notify(
  tx: Tx,
  storeId: string,
  kind: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(notifications).values({ storeId, kind, data });
}

/** Avisos internos da loja. Cada pessoa marca como lida no seu ritmo. */
export class NotificationService {
  constructor(private readonly db: Db) {}

  async list(
    context: Context,
    query: { limit: number; cursor?: string; unread?: boolean },
  ): Promise<Page<NotificationView> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const rows = await withContext(this.db, context, (tx) =>
      tx
        .select({ row: notifications, readAt: notificationReads.readAt })
        .from(notifications)
        .leftJoin(
          notificationReads,
          and(
            eq(notificationReads.notificationId, notifications.id),
            eq(notificationReads.userId, context.userId),
          ),
        )
        .where(
          and(
            eq(notifications.storeId, context.storeId),
            query.unread === true ? isNull(notificationReads.readAt) : undefined,
            position === null
              ? undefined
              : sql`(${notifications.createdAt}, ${notifications.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit + 1),
    );
    return toPage(
      rows.map(({ row, readAt }) => ({
        id: row.id,
        kind: row.kind,
        data: row.data,
        read: readAt !== null,
        createdAt: row.createdAt,
      })),
      query.limit,
    );
  }

  async unreadCount(context: Context): Promise<number> {
    return withContext(this.db, context, async (tx) => {
      const result = await tx.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM notifications n
         WHERE n.store_id = ${context.storeId}::uuid
           AND NOT EXISTS (SELECT 1 FROM notification_reads r
                            WHERE r.notification_id = n.id AND r.user_id = ${context.userId}::uuid)
      `);
      return Number(result.rows[0]?.n ?? 0);
    });
  }

  /** Marca uma como lida. `false` se não existir na loja. Repetir é inofensivo. */
  async markRead(context: Context, id: string): Promise<boolean> {
    return withContext(this.db, context, async (tx) => {
      const [found] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.id, id), eq(notifications.storeId, context.storeId)));
      if (found === undefined) return false;
      await tx
        .insert(notificationReads)
        .values({ notificationId: id, storeId: context.storeId, userId: context.userId })
        .onConflictDoNothing();
      return true;
    });
  }

  /** Marca todas as da loja como lidas para quem pediu. Devolve quantas eram novas. */
  async markAllRead(context: Context): Promise<number> {
    return withContext(this.db, context, async (tx) => {
      const result = await tx.execute<{ id: string }>(sql`
        INSERT INTO notification_reads (notification_id, store_id, user_id)
        SELECT n.id, n.store_id, ${context.userId}::uuid FROM notifications n
         WHERE n.store_id = ${context.storeId}::uuid
        ON CONFLICT DO NOTHING
        RETURNING notification_id AS id
      `);
      return result.rows.length;
    });
  }
}
