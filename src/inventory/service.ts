import { and, desc, eq, inArray, notExists, or, sql, type SQL } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { toCatalogCard, type CatalogCard } from '../catalog/service.js';
import { normalizeText } from '../catalog/normalize.js';
import { withContext, type Db, type Tx } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';

const { cardsInventory, tcgdexCatalog, customers, auctions, bids, stores } = schema;

export type Condition = (typeof schema.cardCondition.enumValues)[number];
export type Ownership = (typeof schema.ownershipType.enumValues)[number];
export type CardStatus = (typeof schema.cardStatus.enumValues)[number];

const OPEN_AUCTION = ['PENDING', 'ACTIVE', 'PAUSED_FOR_VALIDATION'] as const;

interface Context {
  storeId: string;
  userId: string;
}

export interface InventoryCard {
  id: string;
  shortCode: string;
  catalog: CatalogCard;
  language: string;
  condition: Condition;
  isFoil: boolean;
  photos: string[];
  notes: string | null;
  origin: Ownership;
  consignor: { id: string; name: string } | null;
  commissionPct: string | null;
  status: CardStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuctionHistoryItem {
  id: string;
  type: string;
  status: string;
  startTime: Date;
  endTime: Date;
  initialBid: string;
  winningAmount: string | null;
}

export interface CreateCardInput {
  tcgdexId: string;
  language: string;
  condition: Condition;
  isFoil: boolean;
  notes?: string | null;
  origin: Ownership;
  consignorId?: string | null;
  commissionPct?: string | null;
  shortCode?: string;
}

export interface UpdateCardInput {
  tcgdexId?: string;
  language?: string;
  condition?: Condition;
  isFoil?: boolean;
  notes?: string | null;
  origin?: Ownership;
  consignorId?: string | null;
  commissionPct?: string | null;
}

export type CardFailure =
  | 'CATALOG_CARD_NOT_FOUND'
  | 'CONSIGNOR_NOT_FOUND'
  | 'SHORT_CODE_TAKEN'
  | 'OWNERSHIP_INVALID'
  | 'CARD_LIMIT';

export type CreateResult = { ok: true; card: InventoryCard } | { ok: false; reason: CardFailure };
export type UpdateResult =
  | { ok: true; card: InventoryCard }
  | { ok: false; reason: CardFailure | 'NOT_FOUND' | 'CARD_LOCKED' };
export type DeleteResult =
  | { ok: true; photos: string[] }
  | { ok: false; reason: 'NOT_FOUND' | 'CARD_LOCKED' | 'CARD_HAS_HISTORY' };

export interface ListQuery {
  limit: number;
  cursor?: string;
  status?: CardStatus;
  origin?: Ownership;
  consignorId?: string;
  language?: string;
  q?: string;
  /** Só cartas que nunca foram a leilão. */
  noAuction?: boolean;
}

const row = {
  card: cardsInventory,
  catalog: tcgdexCatalog,
  consignorName: customers.name,
} as const;

type Joined = {
  card: typeof cardsInventory.$inferSelect;
  catalog: typeof tcgdexCatalog.$inferSelect;
  consignorName: string | null;
};

function toInventoryCard({ card, catalog, consignorName }: Joined): InventoryCard {
  return {
    id: card.id,
    shortCode: card.shortCode,
    catalog: toCatalogCard(catalog),
    language: card.language,
    condition: card.condition,
    isFoil: card.isFoil,
    photos: card.customPhotos,
    notes: card.notes,
    origin: card.ownershipType,
    consignor:
      card.consignorId === null ? null : { id: card.consignorId, name: consignorName ?? '' },
    commissionPct: card.storeCommissionPct,
    status: card.status,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

/** Código curto automático: `A1`, `A2`, ... por loja. Chamado com o lock da loja já tomado. */
async function nextShortCode(tx: Tx, storeId: string): Promise<string> {
  const result = await tx.execute<{ next: number }>(sql`
    SELECT coalesce(max(substring(short_code FROM 2)::int), 0) + 1 AS next
      FROM cards_inventory
     WHERE store_id = ${storeId} AND short_code ~ '^A[0-9]{1,9}$'
  `);
  return `A${String(result.rows[0]?.next ?? 1)}`;
}

/** Serializa as criações de uma loja: o código curto nunca colide e a checagem não corre. */
async function lockStore(tx: Tx, storeId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${storeId}, 7))`);
}

/** Exige consistência da origem: própria não tem dono nem comissão; consignada tem os dois. */
function ownershipOk(origin: Ownership, consignorId: string | null, pct: string | null): boolean {
  return origin === 'OWN'
    ? consignorId === null && pct === null
    : consignorId !== null && pct !== null;
}

/** Estoque da loja (ADR 0002 e 0013). Tudo no contexto da loja (RLS) e com log de atividades. */
export class InventoryService {
  constructor(private readonly db: Db) {}

  private async fetch(tx: Tx, storeId: string, id: string): Promise<InventoryCard | null> {
    const [found] = await tx
      .select(row)
      .from(cardsInventory)
      .innerJoin(tcgdexCatalog, eq(tcgdexCatalog.id, cardsInventory.tcgdexId))
      .leftJoin(
        customers,
        and(eq(customers.id, cardsInventory.consignorId), eq(customers.storeId, storeId)),
      )
      .where(and(eq(cardsInventory.id, id), eq(cardsInventory.storeId, storeId)))
      .limit(1);
    return found === undefined ? null : toInventoryCard(found);
  }

  async create(context: Context, input: CreateCardInput): Promise<CreateResult> {
    const consignorId = input.origin === 'CONSIGNED' ? (input.consignorId ?? null) : null;
    const pct = input.origin === 'CONSIGNED' ? (input.commissionPct ?? null) : null;
    if (!ownershipOk(input.origin, input.consignorId ?? null, input.commissionPct ?? null)) {
      return { ok: false, reason: 'OWNERSHIP_INVALID' };
    }

    return withContext(this.db, context, async (tx) => {
      const failure = await this.checkReferences(tx, context.storeId, input.tcgdexId, consignorId);
      if (failure !== null) return { ok: false, reason: failure } as const;

      await lockStore(tx, context.storeId);
      if (await this.atCardLimit(tx, context.storeId)) {
        return { ok: false, reason: 'CARD_LIMIT' } as const;
      }
      const shortCode = input.shortCode ?? (await nextShortCode(tx, context.storeId));
      const [taken] = await tx
        .select({ id: cardsInventory.id })
        .from(cardsInventory)
        .where(
          and(eq(cardsInventory.storeId, context.storeId), eq(cardsInventory.shortCode, shortCode)),
        )
        .limit(1);
      if (taken !== undefined) return { ok: false, reason: 'SHORT_CODE_TAKEN' } as const;

      const [created] = await tx
        .insert(cardsInventory)
        .values({
          storeId: context.storeId,
          shortCode,
          tcgdexId: input.tcgdexId,
          language: input.language,
          condition: input.condition,
          isFoil: input.isFoil,
          notes: input.notes ?? null,
          ownershipType: input.origin,
          consignorId,
          storeCommissionPct: pct,
        })
        .returning({ id: cardsInventory.id });
      if (created === undefined) throw new Error('a carta não foi criada');
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'card.created',
        targetType: 'card',
        targetId: created.id,
        details: { short_code: shortCode, origin: input.origin },
      });
      const card = await this.fetch(tx, context.storeId, created.id);
      if (card === null) throw new Error('a carta criada não foi encontrada');
      return { ok: true, card } as const;
    });
  }

  /** O plano da loja (definido pela administração) limita o total de cartas; sem valor, ilimitado. */
  private async atCardLimit(tx: Tx, storeId: string): Promise<boolean> {
    const [store] = await tx
      .select({ limit: stores.cardLimit })
      .from(stores)
      .where(eq(stores.id, storeId))
      .limit(1);
    if (store?.limit == null) return false;
    const [total] = await tx
      .select({ n: sql<string>`count(*)` })
      .from(cardsInventory)
      .where(eq(cardsInventory.storeId, storeId));
    return Number(total?.n ?? 0) >= store.limit;
  }

  private async checkReferences(
    tx: Tx,
    storeId: string,
    tcgdexId: string | undefined,
    consignorId: string | null | undefined,
  ): Promise<CardFailure | null> {
    if (tcgdexId !== undefined) {
      const [catalog] = await tx
        .select({ id: tcgdexCatalog.id })
        .from(tcgdexCatalog)
        .where(eq(tcgdexCatalog.id, tcgdexId))
        .limit(1);
      if (catalog === undefined) return 'CATALOG_CARD_NOT_FOUND';
    }
    if (consignorId !== undefined && consignorId !== null) {
      const [owner] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, consignorId), eq(customers.storeId, storeId)))
        .limit(1);
      if (owner === undefined) return 'CONSIGNOR_NOT_FOUND';
    }
    return null;
  }

  async list(context: Context, query: ListQuery): Promise<Page<InventoryCard> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';

    const conditions: (SQL | undefined)[] = [
      eq(cardsInventory.storeId, context.storeId),
      query.status === undefined ? undefined : eq(cardsInventory.status, query.status),
      query.origin === undefined ? undefined : eq(cardsInventory.ownershipType, query.origin),
      query.consignorId === undefined
        ? undefined
        : eq(cardsInventory.consignorId, query.consignorId),
      query.language === undefined ? undefined : eq(cardsInventory.language, query.language),
      query.noAuction === true
        ? notExists(
            this.db
              .select({ one: sql`1` })
              .from(auctions)
              .where(eq(auctions.cardId, cardsInventory.id)),
          )
        : undefined,
      position === null
        ? undefined
        : sql`(${cardsInventory.createdAt}, ${cardsInventory.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
    ];
    const text = normalizeText(query.q ?? '');
    if (text !== '') {
      const pattern = '%' + text.replaceAll(/[\\%_]/g, '\\$&') + '%';
      conditions.push(
        or(
          sql`${tcgdexCatalog.searchText} ILIKE ${pattern} ESCAPE '\\'`,
          sql`lower(${cardsInventory.shortCode}) = ${text}`,
        ),
      );
    }

    const rows = await withContext(this.db, context, (tx) =>
      tx
        .select(row)
        .from(cardsInventory)
        .innerJoin(tcgdexCatalog, eq(tcgdexCatalog.id, cardsInventory.tcgdexId))
        .leftJoin(
          customers,
          and(eq(customers.id, cardsInventory.consignorId), eq(customers.storeId, context.storeId)),
        )
        .where(and(...conditions))
        .orderBy(desc(cardsInventory.createdAt), desc(cardsInventory.id))
        .limit(query.limit + 1),
    );
    return toPage(rows.map(toInventoryCard), query.limit);
  }

  async get(
    context: Context,
    id: string,
  ): Promise<{ card: InventoryCard; auctions: AuctionHistoryItem[] } | null> {
    return withContext(this.db, context, async (tx) => {
      const card = await this.fetch(tx, context.storeId, id);
      if (card === null) return null;
      const history = await tx
        .select({
          id: auctions.id,
          type: auctions.type,
          status: auctions.status,
          startTime: auctions.startTime,
          endTime: auctions.endTime,
          initialBid: auctions.initialBid,
          winningAmount: bids.amount,
        })
        .from(auctions)
        .leftJoin(bids, and(eq(bids.id, auctions.winningBidId), eq(bids.storeId, context.storeId)))
        .where(and(eq(auctions.cardId, id), eq(auctions.storeId, context.storeId)))
        .orderBy(desc(auctions.startTime), desc(auctions.id));
      return { card, auctions: history };
    });
  }

  /** Edita uma carta. Só enquanto está disponível e fora de qualquer leilão em andamento. */
  async update(context: Context, id: string, input: UpdateCardInput): Promise<UpdateResult> {
    return withContext(this.db, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(cardsInventory)
        .where(and(eq(cardsInventory.id, id), eq(cardsInventory.storeId, context.storeId)))
        .for('update')
        .limit(1);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (current.status !== 'AVAILABLE' || (await this.hasOpenAuction(tx, id))) {
        return { ok: false, reason: 'CARD_LOCKED' } as const;
      }

      const origin = input.origin ?? current.ownershipType;
      const consignorId = this.resolveOwnership(input, origin, current.consignorId);
      const pct = this.resolveCommission(input, origin, current.storeCommissionPct);
      if (!ownershipOk(origin, consignorId, pct)) {
        return { ok: false, reason: 'OWNERSHIP_INVALID' } as const;
      }
      const failure = await this.checkReferences(
        tx,
        context.storeId,
        input.tcgdexId,
        input.consignorId === undefined ? undefined : consignorId,
      );
      if (failure !== null) return { ok: false, reason: failure } as const;

      const changed = Object.keys(input).filter(
        (key) => input[key as keyof UpdateCardInput] !== undefined,
      );
      await tx
        .update(cardsInventory)
        .set({
          ...(input.tcgdexId === undefined ? {} : { tcgdexId: input.tcgdexId }),
          ...(input.language === undefined ? {} : { language: input.language }),
          ...(input.condition === undefined ? {} : { condition: input.condition }),
          ...(input.isFoil === undefined ? {} : { isFoil: input.isFoil }),
          ...(input.notes === undefined ? {} : { notes: input.notes }),
          ownershipType: origin,
          consignorId,
          storeCommissionPct: pct,
          updatedAt: new Date(),
        })
        .where(eq(cardsInventory.id, id));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'card.updated',
        targetType: 'card',
        targetId: id,
        details: { short_code: current.shortCode, changed },
      });
      const card = await this.fetch(tx, context.storeId, id);
      if (card === null) throw new Error('a carta editada não foi encontrada');
      return { ok: true, card } as const;
    });
  }

  /** Trocar para própria zera o dono; consignada mantém o dono atual se nada foi informado. */
  private resolveOwnership(
    input: UpdateCardInput,
    origin: Ownership,
    current: string | null,
  ): string | null {
    if (origin === 'OWN') return null;
    return input.consignorId === undefined ? current : input.consignorId;
  }

  private resolveCommission(
    input: UpdateCardInput,
    origin: Ownership,
    current: string | null,
  ): string | null {
    if (origin === 'OWN') return null;
    return input.commissionPct === undefined ? current : input.commissionPct;
  }

  private async hasOpenAuction(tx: Tx, cardId: string): Promise<boolean> {
    const [open] = await tx
      .select({ id: auctions.id })
      .from(auctions)
      .where(and(eq(auctions.cardId, cardId), inArray(auctions.status, OPEN_AUCTION)))
      .limit(1);
    return open !== undefined;
  }

  /** Exclui só carta disponível que nunca foi a leilão: quem já teve lance fica no histórico. */
  async remove(context: Context, id: string): Promise<DeleteResult> {
    return withContext(this.db, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(cardsInventory)
        .where(and(eq(cardsInventory.id, id), eq(cardsInventory.storeId, context.storeId)))
        .for('update')
        .limit(1);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (current.status !== 'AVAILABLE' || (await this.hasOpenAuction(tx, id))) {
        return { ok: false, reason: 'CARD_LOCKED' } as const;
      }
      const [past] = await tx
        .select({ id: auctions.id })
        .from(auctions)
        .where(eq(auctions.cardId, id))
        .limit(1);
      if (past !== undefined) return { ok: false, reason: 'CARD_HAS_HISTORY' } as const;

      await tx.delete(cardsInventory).where(eq(cardsInventory.id, id));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'card.deleted',
        targetType: 'card',
        targetId: id,
        details: { short_code: current.shortCode, tcgdex_id: current.tcgdexId },
      });
      return { ok: true, photos: current.customPhotos } as const;
    });
  }
}
