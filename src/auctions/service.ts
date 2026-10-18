import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { toCatalogCard, type CatalogCard } from '../catalog/service.js';
import { withContext, type Db, type Tx } from '../db/context.js';
import * as schema from '../db/schema.js';
import { decodeCursor, toPage, type Page } from '../http/pagination.js';

const { auctions, bids, cardsInventory, customers, stores, tcgdexCatalog } = schema;

export type AuctionType = (typeof schema.auctionType.enumValues)[number];
export type AuctionStatus = (typeof schema.auctionStatus.enumValues)[number];

const OPEN: AuctionStatus[] = ['PENDING', 'ACTIVE', 'PAUSED_FOR_VALIDATION'];
const LIVE: AuctionStatus[] = ['ACTIVE', 'PAUSED_FOR_VALIDATION'];
/** Tolerância entre o relógio do navegador e o do servidor ao agendar "agora". */
const CLOCK_SKEW_MS = 5 * 60_000;

interface Context {
  storeId: string;
  userId: string;
}

export interface AuctionView {
  id: string;
  card: {
    id: string;
    shortCode: string;
    language: string;
    condition: string;
    catalog: CatalogCard;
  };
  type: AuctionType;
  status: AuctionStatus;
  startTime: Date;
  endTime: Date;
  initialBid: string;
  minIncrement: string;
  maxPollValue: string | null;
  ceilingAlert: boolean;
  currentBid: string | null;
  bidCount: number;
  leader: { id: string; name: string } | null;
  winningBidId: string | null;
  createdAt: Date;
}

export interface BidView {
  id: string;
  amount: string;
  createdAt: Date;
  customer: { id: string; name: string; phoneMasked: string };
}

export interface CreateAuctionInput {
  cardId: string;
  type: AuctionType;
  /** `null` = lançar agora. */
  startTime: Date | null;
  endTime: Date;
  initialBid: string;
  minIncrement: string;
  maxPollValue?: string | null;
}

export interface UpdateAuctionInput {
  type?: AuctionType;
  startTime?: Date;
  endTime?: Date;
  initialBid?: string;
  minIncrement?: string;
  maxPollValue?: string | null;
}

export type AuctionFailure =
  | 'NOT_FOUND'
  | 'CARD_NOT_FOUND'
  | 'CARD_NOT_AVAILABLE'
  | 'INVALID_PERIOD'
  | 'INVALID_VALUES'
  | 'AUCTION_LOCKED'
  | 'NOT_PAUSED'
  | 'NOT_LIVE';

export type AuctionResult =
  { ok: true; auction: AuctionView } | { ok: false; reason: AuctionFailure };

export type BidOutcome =
  | 'ACCEPTED'
  | 'AUCTION_NOT_FOUND'
  | 'AUCTION_NOT_ACTIVE'
  | 'NOT_STARTED'
  | 'ENDED'
  | 'CUSTOMER_NOT_FOUND'
  | 'CUSTOMER_BLACKLISTED'
  | 'INVALID_AMOUNT'
  | 'BID_TOO_LOW';

export interface PlaceBidResult {
  outcome: BidOutcome;
  bidId: string | null;
  minAmount: string | null;
  currentAmount: string | null;
  status: AuctionStatus | null;
  ceilingReached: boolean;
}

export interface ListQuery {
  limit: number;
  cursor?: string;
  status?: AuctionStatus;
}

const cents = (value: string): number => Math.round(Number(value) * 100);

/** Telefone sem o miolo: `55119•••••12`. Nunca devolvemos o número inteiro nas listas. */
export function maskPhone(phone: string): string {
  if (phone.length <= 6) return '•'.repeat(phone.length);
  return phone.slice(0, 5) + '•'.repeat(phone.length - 7) + phone.slice(-2);
}

/** Regras de valor e período, iguais na criação e na edição. */
function validateTerms(terms: {
  type: AuctionType;
  start: Date;
  end: Date;
  initial: string;
  increment: string;
  ceiling: string | null;
}): AuctionFailure | null {
  if (terms.end <= terms.start) return 'INVALID_PERIOD';
  if (cents(terms.initial) <= 0 || cents(terms.increment) <= 0) return 'INVALID_VALUES';
  if (terms.type === 'FREE_BID') return terms.ceiling === null ? null : 'INVALID_VALUES';
  if (terms.ceiling === null || cents(terms.ceiling) <= cents(terms.initial)) {
    return 'INVALID_VALUES';
  }
  return null;
}

/** Leilões da loja (ADR 0004, 0013, 0016). Tudo no contexto da loja (RLS) e com log de atividades. */
export class AuctionService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Vira o estado dos leilões da loja conforme o relógio do banco (abre, encerra). */
  private async advance(tx: Tx, storeId: string): Promise<void> {
    await tx.execute(sql`SELECT * FROM advance_auctions(${storeId}::uuid)`);
  }

  private async views(
    tx: Tx,
    storeId: string,
    where: SQL | undefined,
    limit: number,
    cursor?: SQL,
  ) {
    const rows = await tx
      .select({
        auction: auctions,
        card: cardsInventory,
        catalog: tcgdexCatalog,
      })
      .from(auctions)
      .innerJoin(
        cardsInventory,
        and(eq(cardsInventory.id, auctions.cardId), eq(cardsInventory.storeId, storeId)),
      )
      .innerJoin(tcgdexCatalog, eq(tcgdexCatalog.id, cardsInventory.tcgdexId))
      .where(and(eq(auctions.storeId, storeId), where, cursor))
      .orderBy(desc(auctions.createdAt), desc(auctions.id))
      .limit(limit);
    if (rows.length === 0) return [];

    const idList = sql.join(
      rows.map((r) => sql`${r.auction.id}::uuid`),
      sql`, `,
    );
    const stats = await tx.execute<{
      auction_id: string;
      top: string;
      total: string;
      leader_id: string;
      leader_name: string;
    }>(sql`
      SELECT s.auction_id, s.top, s.total, b.customer_id AS leader_id, c.name AS leader_name
        FROM (SELECT auction_id, max(amount) AS top, count(*) AS total
                FROM bids
               WHERE store_id = ${storeId}::uuid AND auction_id IN (${idList})
               GROUP BY auction_id) s
        JOIN bids b ON b.auction_id = s.auction_id AND b.amount = s.top
        JOIN customers c ON c.id = b.customer_id AND c.store_id = ${storeId}::uuid
    `);
    const byAuction = new Map(stats.rows.map((r) => [r.auction_id, r]));

    return rows.map(({ auction, card, catalog }): AuctionView => {
      const stat = byAuction.get(auction.id);
      return {
        id: auction.id,
        card: {
          id: card.id,
          shortCode: card.shortCode,
          language: card.language,
          condition: card.condition,
          catalog: toCatalogCard(catalog),
        },
        type: auction.type,
        status: auction.status,
        startTime: auction.startTime,
        endTime: auction.endTime,
        initialBid: auction.initialBid,
        minIncrement: auction.minIncrement,
        maxPollValue: auction.maxPollValue,
        ceilingAlert: auction.maxValueReachedAlert,
        currentBid: stat?.top ?? null,
        bidCount: stat === undefined ? 0 : Number(stat.total),
        leader: stat === undefined ? null : { id: stat.leader_id, name: stat.leader_name },
        winningBidId: auction.winningBidId,
        createdAt: auction.createdAt,
      };
    });
  }

  private async viewOf(tx: Tx, storeId: string, id: string): Promise<AuctionView> {
    const [view] = await this.views(tx, storeId, eq(auctions.id, id), 1);
    if (view === undefined) throw new Error('o leilão não foi encontrado');
    return view;
  }

  async create(context: Context, input: CreateAuctionInput): Promise<AuctionResult> {
    const now = this.now();
    const start = input.startTime ?? now;
    const ceiling = input.maxPollValue ?? null;
    const invalid = validateTerms({
      type: input.type,
      start,
      end: input.endTime,
      initial: input.initialBid,
      increment: input.minIncrement,
      ceiling,
    });
    if (invalid !== null) return { ok: false, reason: invalid };
    if (
      input.endTime <= now ||
      (input.startTime !== null && input.startTime.getTime() < now.getTime() - CLOCK_SKEW_MS)
    ) {
      return { ok: false, reason: 'INVALID_PERIOD' };
    }

    return withContext(this.db, context, async (tx) => {
      const [card] = await tx
        .select()
        .from(cardsInventory)
        .where(
          and(eq(cardsInventory.id, input.cardId), eq(cardsInventory.storeId, context.storeId)),
        )
        .for('update')
        .limit(1);
      if (card === undefined) return { ok: false, reason: 'CARD_NOT_FOUND' } as const;
      await this.advance(tx, context.storeId);
      const [fresh] = await tx
        .select({ status: cardsInventory.status })
        .from(cardsInventory)
        .where(eq(cardsInventory.id, card.id));
      const [open] = await tx
        .select({ id: auctions.id })
        .from(auctions)
        .where(and(eq(auctions.cardId, card.id), inArray(auctions.status, OPEN)))
        .limit(1);
      if (fresh?.status !== 'AVAILABLE' || open !== undefined) {
        return { ok: false, reason: 'CARD_NOT_AVAILABLE' } as const;
      }

      const startsNow = input.startTime === null;
      const [created] = await tx
        .insert(auctions)
        .values({
          storeId: context.storeId,
          cardId: card.id,
          type: input.type,
          startTime: start,
          endTime: input.endTime,
          initialBid: input.initialBid,
          minIncrement: input.minIncrement,
          maxPollValue: ceiling,
          status: startsNow ? 'ACTIVE' : 'PENDING',
        })
        .returning({ id: auctions.id });
      if (created === undefined) throw new Error('o leilão não foi criado');
      await tx
        .update(cardsInventory)
        .set({ status: 'SCHEDULED', updatedAt: now })
        .where(eq(cardsInventory.id, card.id));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'auction.created',
        targetType: 'auction',
        targetId: created.id,
        details: { card_id: card.id, short_code: card.shortCode, type: input.type, now: startsNow },
      });
      return { ok: true, auction: await this.viewOf(tx, context.storeId, created.id) } as const;
    });
  }

  async list(context: Context, query: ListQuery): Promise<Page<AuctionView> | 'INVALID_CURSOR'> {
    const position = query.cursor === undefined ? null : decodeCursor(query.cursor);
    if (query.cursor !== undefined && position === null) return 'INVALID_CURSOR';
    const rows = await withContext(this.db, context, async (tx) => {
      await this.advance(tx, context.storeId);
      return this.views(
        tx,
        context.storeId,
        query.status === undefined ? undefined : eq(auctions.status, query.status),
        query.limit + 1,
        position === null
          ? undefined
          : sql`(${auctions.createdAt}, ${auctions.id}) < (${position.createdAt.toISOString()}::timestamptz, ${position.id}::uuid)`,
      );
    });
    return toPage(rows, query.limit);
  }

  async get(
    context: Context,
    id: string,
  ): Promise<{ auction: AuctionView; bids: BidView[] } | null> {
    return withContext(this.db, context, async (tx) => {
      await this.advance(tx, context.storeId);
      const [auction] = await this.views(tx, context.storeId, eq(auctions.id, id), 1);
      if (auction === undefined) return null;
      const rows = await tx
        .select({ bid: bids, name: customers.name, phone: customers.phone })
        .from(bids)
        .innerJoin(
          customers,
          and(eq(customers.id, bids.customerId), eq(customers.storeId, context.storeId)),
        )
        .where(and(eq(bids.auctionId, id), eq(bids.storeId, context.storeId)))
        .orderBy(desc(bids.amount))
        .limit(100);
      return {
        auction,
        bids: rows.map(({ bid, name, phone }) => ({
          id: bid.id,
          amount: bid.amount,
          createdAt: bid.createdAt,
          customer: { id: bid.customerId, name, phoneMasked: maskPhone(phone) },
        })),
      };
    });
  }

  /** Trava a linha do leilão e vira o relógio antes de decidir. */
  private async lock(tx: Tx, storeId: string, id: string) {
    await this.advance(tx, storeId);
    const [auction] = await tx
      .select()
      .from(auctions)
      .where(and(eq(auctions.id, id), eq(auctions.storeId, storeId)))
      .for('update')
      .limit(1);
    return auction;
  }

  /**
   * Edita o leilão. Pendente: tudo. Em andamento: só o fim, e nunca para antes de agora.
   * Valores e tipo não mudam depois que o leilão abriu (quem deu lance viu aquelas regras).
   */
  async update(context: Context, id: string, input: UpdateAuctionInput): Promise<AuctionResult> {
    return withContext(this.db, context, async (tx) => {
      const current = await this.lock(tx, context.storeId, id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      const now = this.now();
      const pending = current.status === 'PENDING';
      const live = LIVE.includes(current.status);
      const onlyEnd = Object.keys(input).every((key) => key === 'endTime');
      if (!pending && !(live && onlyEnd)) return { ok: false, reason: 'AUCTION_LOCKED' } as const;

      const merged = {
        type: input.type ?? current.type,
        start: input.startTime ?? current.startTime,
        end: input.endTime ?? current.endTime,
        initial: input.initialBid ?? current.initialBid,
        increment: input.minIncrement ?? current.minIncrement,
        ceiling: input.maxPollValue === undefined ? current.maxPollValue : input.maxPollValue,
      };
      const ceiling = merged.type === 'FREE_BID' ? null : merged.ceiling;
      const invalid = validateTerms({ ...merged, ceiling });
      if (invalid !== null) return { ok: false, reason: invalid } as const;
      if (merged.end <= now) return { ok: false, reason: 'INVALID_PERIOD' } as const;

      await tx
        .update(auctions)
        .set({
          type: merged.type,
          startTime: merged.start,
          endTime: merged.end,
          initialBid: merged.initial,
          minIncrement: merged.increment,
          maxPollValue: ceiling,
        })
        .where(eq(auctions.id, id));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'auction.updated',
        targetType: 'auction',
        targetId: id,
        details: { changed: Object.keys(input) },
      });
      return { ok: true, auction: await this.viewOf(tx, context.storeId, id) } as const;
    });
  }

  /** Cancela enquanto não terminou. Os lances ficam no histórico e a carta volta ao estoque. */
  async cancel(context: Context, id: string): Promise<AuctionResult> {
    return withContext(this.db, context, async (tx) => {
      const current = await this.lock(tx, context.storeId, id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (!OPEN.includes(current.status)) return { ok: false, reason: 'AUCTION_LOCKED' } as const;

      await tx.update(auctions).set({ status: 'CANCELLED' }).where(eq(auctions.id, id));
      await tx
        .update(cardsInventory)
        .set({ status: 'AVAILABLE', updatedAt: this.now() })
        .where(
          and(eq(cardsInventory.id, current.cardId), eq(cardsInventory.storeId, context.storeId)),
        );
      const [count] = await tx
        .select({ n: sql<string>`count(*)` })
        .from(bids)
        .where(and(eq(bids.auctionId, id), eq(bids.storeId, context.storeId)));
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: 'auction.cancelled',
        targetType: 'auction',
        targetId: id,
        details: { previous_status: current.status, bids: Number(count?.n ?? 0) },
      });
      return { ok: true, auction: await this.viewOf(tx, context.storeId, id) } as const;
    });
  }

  /** Decide a enquete que chegou ao teto: aprova o encerramento ou mantém aberta. */
  async resolve(
    context: Context,
    id: string,
    decision: 'APPROVE' | 'KEEP_OPEN',
  ): Promise<AuctionResult> {
    return withContext(this.db, context, async (tx) => {
      const current = await this.lock(tx, context.storeId, id);
      if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
      if (current.status !== 'PAUSED_FOR_VALIDATION') {
        return { ok: false, reason: 'NOT_PAUSED' } as const;
      }

      if (decision === 'KEEP_OPEN') {
        await tx
          .update(auctions)
          .set({ status: 'ACTIVE', maxValueReachedAlert: false })
          .where(eq(auctions.id, id));
      } else {
        const [top] = await tx
          .select({ id: bids.id })
          .from(bids)
          .where(and(eq(bids.auctionId, id), eq(bids.storeId, context.storeId)))
          .orderBy(desc(bids.amount))
          .limit(1);
        await tx
          .update(auctions)
          .set({ status: 'FINISHED', winningBidId: top?.id ?? null, maxValueReachedAlert: false })
          .where(eq(auctions.id, id));
        await tx
          .update(cardsInventory)
          .set({
            status: top === undefined ? 'AVAILABLE' : 'AWAITING_CONFIRMATION',
            updatedAt: this.now(),
          })
          .where(
            and(eq(cardsInventory.id, current.cardId), eq(cardsInventory.storeId, context.storeId)),
          );
      }
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: decision === 'APPROVE' ? 'auction.poll_approved' : 'auction.poll_kept_open',
        targetType: 'auction',
        targetId: id,
      });
      return { ok: true, auction: await this.viewOf(tx, context.storeId, id) } as const;
    });
  }

  /** Estende o fim de um leilão em andamento (ou de todos), por exemplo depois de uma queda do WhatsApp. */
  async extend(
    context: Context,
    minutes: number,
    id?: string,
  ): Promise<{ ok: true; extended: string[] } | { ok: false; reason: AuctionFailure }> {
    return withContext(this.db, context, async (tx) => {
      await this.advance(tx, context.storeId);
      if (id !== undefined) {
        const current = await this.lock(tx, context.storeId, id);
        if (current === undefined) return { ok: false, reason: 'NOT_FOUND' } as const;
        if (!LIVE.includes(current.status)) return { ok: false, reason: 'NOT_LIVE' } as const;
      }
      const rows = await tx
        .update(auctions)
        .set({ endTime: sql`${auctions.endTime} + make_interval(mins => ${minutes})` })
        .where(
          and(
            eq(auctions.storeId, context.storeId),
            inArray(auctions.status, LIVE),
            id === undefined ? undefined : eq(auctions.id, id),
          ),
        )
        .returning({ id: auctions.id });
      const extended = rows.map((row) => row.id);
      await recordActivity(tx, {
        storeId: context.storeId,
        actorUserId: context.userId,
        action: id === undefined ? 'auction.extended_all' : 'auction.extended',
        targetType: id === undefined ? undefined : 'auction',
        targetId: id,
        details: { minutes, count: extended.length },
      });
      return { ok: true, extended } as const;
    });
  }

  /** A regra de lance vive no banco (`place_bid`, ADR 0016); aqui só se chama e se traduz. */
  async placeBid(
    context: Context,
    input: { auctionId: string; customerId: string; amount: string; rawMessage: string },
  ): Promise<PlaceBidResult> {
    return withContext(this.db, context, async (tx) => {
      const result = await tx.execute<{
        outcome: BidOutcome;
        bid_id: string | null;
        min_amount: string | null;
        current_amount: string | null;
        new_status: AuctionStatus | null;
        ceiling_reached: boolean;
      }>(sql`
        SELECT * FROM place_bid(${context.storeId}::uuid, ${input.auctionId}::uuid,
          ${input.customerId}::uuid, ${input.amount}::numeric, ${input.rawMessage})
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error('place_bid não devolveu resultado');
      if (row.outcome === 'ACCEPTED') {
        await recordActivity(tx, {
          storeId: context.storeId,
          actorUserId: context.userId,
          action: 'bid.registered',
          targetType: 'auction',
          targetId: input.auctionId,
          details: { bid_id: row.bid_id, ceiling_reached: row.ceiling_reached },
        });
      }
      return {
        outcome: row.outcome,
        bidId: row.bid_id,
        minAmount: row.min_amount,
        currentAmount: row.current_amount,
        status: row.new_status,
        ceilingReached: row.ceiling_reached,
      };
    });
  }

  /** Leilões em andamento e o estado do WhatsApp da loja (alerta de queda). */
  async affected(context: Context): Promise<{
    whatsappStatus: (typeof schema.whatsappStatus.enumValues)[number];
    auctions: AuctionView[];
  }> {
    return withContext(this.db, context, async (tx) => {
      await this.advance(tx, context.storeId);
      const [store] = await tx
        .select({ status: stores.whatsappStatus })
        .from(stores)
        .where(eq(stores.id, context.storeId));
      const live = await this.views(tx, context.storeId, inArray(auctions.status, LIVE), 200);
      const whatsappStatus = store?.status ?? 'OFFLINE';
      return { whatsappStatus, auctions: whatsappStatus === 'ONLINE' ? [] : live };
    });
  }
}
