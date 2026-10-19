import { createHash, randomBytes } from 'node:crypto';

import { and, desc, eq, isNull, sql } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { withContext, type Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';

const { publicLinks, settlements, customers } = schema;

interface Context {
  storeId: string;
  userId: string;
}

export type LinkKind = (typeof schema.publicLinkKind.enumValues)[number];
export type LinkState = 'ACTIVE' | 'EXPIRED' | 'REVOKED' | 'LOCKED';

export interface LinkView {
  id: string;
  kind: LinkKind;
  settlementId: string | null;
  customerId: string | null;
  state: LinkState;
  expiresAt: Date;
  lockedUntil: Date | null;
  createdAt: Date;
}

export type CreateLinkResult =
  { ok: true; link: LinkView; token: string } | { ok: false; reason: 'NOT_FOUND' | 'CPF_REQUIRED' };

/** Token de 256 bits. Só o hash vai para o banco; o texto sai uma única vez, na criação. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

function stateOf(row: typeof publicLinks.$inferSelect, now: Date): LinkState {
  if (row.revokedAt !== null) return 'REVOKED';
  if (row.expiresAt <= now) return 'EXPIRED';
  if (row.lockedUntil !== null && row.lockedUntil > now) return 'LOCKED';
  return 'ACTIVE';
}

const toView = (row: typeof publicLinks.$inferSelect): LinkView => ({
  id: row.id,
  kind: row.kind,
  settlementId: row.settlementId,
  customerId: row.customerId,
  state: stateOf(row, new Date()),
  expiresAt: row.expiresAt,
  lockedUntil: row.lockedUntil,
  createdAt: row.createdAt,
});

/** Links públicos da loja (acerto do comprador e acompanhamento do consignador). */
export class PublicLinkService {
  constructor(private readonly db: Db) {}

  /**
   * Gera o link de um acerto ou de um consignador. Só há um link ativo por alvo: o anterior é
   * revogado. O consignador precisa ter CPF cadastrado (os 4 primeiros dígitos são a chave).
   */
  async create(
    context: Context,
    target:
      { kind: 'SETTLEMENT'; settlementId: string } | { kind: 'CONSIGNOR'; customerId: string },
    expiresInDays: number,
  ): Promise<CreateLinkResult> {
    return withContext(this.db, context, async (tx) => {
      if (target.kind === 'SETTLEMENT') {
        const [found] = await tx
          .select({ id: settlements.id })
          .from(settlements)
          .where(
            and(eq(settlements.id, target.settlementId), eq(settlements.storeId, context.storeId)),
          )
          .limit(1);
        if (found === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      } else {
        const [found] = await tx
          .select({ id: customers.id, keyHash: customers.cpfKeyHash })
          .from(customers)
          .where(and(eq(customers.id, target.customerId), eq(customers.storeId, context.storeId)))
          .limit(1);
        if (found === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
        if (found.keyHash === null) {
          return { ok: false, reason: 'CPF_REQUIRED' } as const;
        }
      }

      const targetFilter =
        target.kind === 'SETTLEMENT'
          ? eq(publicLinks.settlementId, target.settlementId)
          : eq(publicLinks.customerId, target.customerId);
      await tx
        .update(publicLinks)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(publicLinks.storeId, context.storeId),
            targetFilter,
            isNull(publicLinks.revokedAt),
          ),
        );

      const token = newToken();
      const [created] = await tx
        .insert(publicLinks)
        .values({
          storeId: context.storeId,
          kind: target.kind,
          settlementId: target.kind === 'SETTLEMENT' ? target.settlementId : null,
          customerId: target.kind === 'CONSIGNOR' ? target.customerId : null,
          tokenHash: hashToken(token),
          expiresAt: sql`now() + make_interval(days => ${expiresInDays})`,
          createdBy: context.userId,
        })
        .returning();
      if (created === undefined) throw new Error('o link não foi criado');
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'public_link.created',
        targetType: 'public_link',
        targetId: created.id,
        // Nunca o token, nem o hash.
        details: { kind: target.kind },
      });
      return { ok: true, link: toView(created), token } as const;
    });
  }

  async list(
    context: Context,
    query: { limit: number; cursor?: string; kind?: LinkKind },
  ): Promise<Page<LinkView> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const rows = await withContext(this.db, context, (tx) =>
      tx
        .select()
        .from(publicLinks)
        .where(
          and(
            eq(publicLinks.storeId, context.storeId),
            query.kind === undefined ? undefined : eq(publicLinks.kind, query.kind),
            position === null
              ? undefined
              : sql`(${publicLinks.createdAt}, ${publicLinks.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
          ),
        )
        .orderBy(desc(publicLinks.createdAt), desc(publicLinks.id))
        .limit(query.limit + 1),
    );
    const page = toPage(rows, query.limit);
    return { items: page.items.map(toView), nextCursor: page.nextCursor };
  }

  /** Revoga o link na hora. Repetir é inofensivo. */
  async revoke(context: Context, id: string): Promise<LinkView | null> {
    return withContext(this.db, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(publicLinks)
        .where(and(eq(publicLinks.id, id), eq(publicLinks.storeId, context.storeId)))
        .for('update')
        .limit(1);
      if (current === undefined) return null;
      if (current.revokedAt !== null) return toView(current);
      const [revoked] = await tx
        .update(publicLinks)
        .set({ revokedAt: new Date() })
        .where(eq(publicLinks.id, id))
        .returning();
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'public_link.revoked',
        targetType: 'public_link',
        targetId: id,
        details: { kind: current.kind },
      });
      return toView(revoked ?? current);
    });
  }
}
