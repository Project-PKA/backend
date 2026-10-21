import { eq, sql } from 'drizzle-orm';

import { recordActivity } from '../audit/activity.js';
import { withContext, type Db, type Tx } from '../db/context.js';
import * as schema from '../db/schema.js';

const { stores, whatsappPairing, whatsappSessions } = schema;

interface Context {
  storeId: string;
  userId: string;
}

/** Repetir o pedido dentro deste prazo devolve o estado e não renova (anti-spam do botão). */
export const PAIR_THROTTLE_SECONDS = 30;
/** O pedido que o bot não atendeu em tanto tempo deixa de contar como "pedido". */
export const PAIR_REQUEST_TTL_MINUTES = 10;

export type PairingState = 'IDLE' | 'REQUESTED' | 'QR_READY' | 'ONLINE' | 'OFFLINE';

export interface PairingStatus {
  state: PairingState;
  requestedAt: Date | null;
  /** O QR atual, só enquanto não vence (60 s). Quem o escaneia liga a conta dele ao bot. */
  qr: { code: string; expiresAt: Date } | null;
  groupId: string | null;
  groupsUpdatedAt: Date | null;
}

export interface WhatsappGroup {
  id: string;
  name: string;
}

export type PairResult =
  { ok: true; status: PairingStatus } | { ok: false; reason: 'ALREADY_CONNECTED' };

/** Estado do pareamento e pedido do QR. Tudo dentro do contexto da loja; a política do banco só deixa o proprietário. */
export class WhatsappPairingService {
  constructor(private readonly db: Db) {}

  async status(context: Context): Promise<PairingStatus> {
    return withContext(this.db, context, (tx) => this.read(tx, context.storeId));
  }

  /** Marca o pedido de QR. O bot o enxerga na próxima rodada. */
  async requestPair(context: Context): Promise<PairResult> {
    return withContext(this.db, context, async (tx) => {
      const [store] = await tx
        .select({ status: stores.whatsappStatus })
        .from(stores)
        .where(eq(stores.id, context.storeId));
      if (store?.status === 'ONLINE') return { ok: false, reason: 'ALREADY_CONNECTED' } as const;

      const renewed = await tx
        .insert(whatsappPairing)
        .values({
          storeId: context.storeId,
          requestedAt: sql`now()`,
          requestedBy: context.userId,
        })
        .onConflictDoUpdate({
          target: whatsappPairing.storeId,
          set: {
            requestedAt: sql`now()`,
            requestedBy: context.userId,
            qrCode: null,
            qrExpiresAt: null,
            updatedAt: sql`now()`,
          },
          setWhere: sql`${whatsappPairing.requestedAt} IS NULL
            OR ${whatsappPairing.requestedAt} < now() - make_interval(secs => ${PAIR_THROTTLE_SECONDS})`,
        })
        .returning({ storeId: whatsappPairing.storeId });
      if (renewed.length > 0) {
        await recordActivity(tx, {
          storeId: context.storeId,
          actorUserId: context.userId,
          action: 'whatsapp.pair_requested',
          targetType: 'store',
          targetId: context.storeId,
        });
      }
      return { ok: true, status: await this.read(tx, context.storeId) } as const;
    });
  }

  /** Grupos da conta conectada, como o bot os publicou. */
  async groups(context: Context): Promise<{ items: WhatsappGroup[]; updatedAt: Date | null }> {
    return withContext(this.db, context, async (tx) => {
      const [row] = await tx
        .select({ groups: whatsappPairing.groups, updatedAt: whatsappPairing.groupsUpdatedAt })
        .from(whatsappPairing)
        .where(eq(whatsappPairing.storeId, context.storeId));
      return { items: parseGroups(row?.groups), updatedAt: row?.updatedAt ?? null };
    });
  }

  private async read(tx: Tx, storeId: string): Promise<PairingStatus> {
    const [store] = await tx
      .select({ status: stores.whatsappStatus, groupId: stores.whatsappGroupId })
      .from(stores)
      .where(eq(stores.id, storeId));
    const [pairing] = await tx
      .select({
        requestedAt: whatsappPairing.requestedAt,
        pending: sql<boolean>`${whatsappPairing.requestedAt} IS NOT NULL
          AND ${whatsappPairing.requestedAt} > now() - make_interval(mins => ${PAIR_REQUEST_TTL_MINUTES})`,
        qrCode: sql<
          string | null
        >`CASE WHEN ${whatsappPairing.qrExpiresAt} > now() THEN ${whatsappPairing.qrCode} END`,
        qrExpiresAt: sql<Date | null>`CASE WHEN ${whatsappPairing.qrExpiresAt} > now() THEN ${whatsappPairing.qrExpiresAt} END`,
        groupsUpdatedAt: whatsappPairing.groupsUpdatedAt,
      })
      .from(whatsappPairing)
      .where(eq(whatsappPairing.storeId, storeId));
    // Só a existência: a credencial da sessão nunca é lida aqui.
    const [session] = await tx
      .select({ one: sql<number>`1` })
      .from(whatsappSessions)
      .where(eq(whatsappSessions.storeId, storeId));

    const qr =
      pairing?.qrCode != null && pairing.qrExpiresAt != null
        ? { code: pairing.qrCode, expiresAt: new Date(pairing.qrExpiresAt) }
        : null;
    let state: PairingState = session === undefined ? 'IDLE' : 'OFFLINE';
    if (pairing?.pending === true) state = 'REQUESTED';
    if (qr !== null) state = 'QR_READY';
    if (store?.status === 'ONLINE') state = 'ONLINE';
    return {
      state,
      requestedAt: pairing?.pending === true ? pairing.requestedAt : null,
      qr: state === 'ONLINE' ? null : qr,
      groupId: store?.groupId ?? null,
      groupsUpdatedAt: pairing?.groupsUpdatedAt ?? null,
    };
  }
}

/** Só `{ id, name }` de texto: o bot é de confiança, mas a lista vem de fora do Backend. */
export function parseGroups(raw: unknown): WhatsappGroup[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item: unknown) => {
    if (typeof item !== 'object' || item === null) return [];
    const { id, name } = item as Record<string, unknown>;
    return typeof id === 'string' && typeof name === 'string' ? [{ id, name }] : [];
  });
}

/** O grupo escolhido precisa estar na lista publicada pelo bot. */
export async function groupIsPublished(tx: Tx, storeId: string, groupId: string): Promise<boolean> {
  const [row] = await tx
    .select({ groups: whatsappPairing.groups })
    .from(whatsappPairing)
    .where(eq(whatsappPairing.storeId, storeId));
  return parseGroups(row?.groups).some((group) => group.id === groupId);
}
