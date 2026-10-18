import { createHash } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';

import { buildSearchText } from '../catalog/normalize.js';
import * as schema from './schema.js';

/**
 * Seed de desenvolvimento e demonstração (docs/database.md, seção 3).
 *
 * Determinístico: IDs fixos e datas fixas, então rodar duas vezes dá o mesmo
 * banco. Cobre cada estado de cada entidade, mais casos de borda (acento,
 * emoji, nulos) e volume suficiente para paginar. Os testes NÃO dependem dele:
 * criam o que precisam.
 *
 * Datas: os leilões em andamento terminam em 2099 e os agendados começam em
 * 2098, para o seed não "vencer" sozinho e o agendador não fechá-los.
 */

type Tx = Parameters<Parameters<NodePgDatabase<typeof schema>['transaction']>[0]>[0];

/** UUID v4 válido e previsível: `kind` identifica a tabela, `n` a linha. */
export function uid(kind: number, n: number): string {
  const head = kind.toString(16).padStart(8, '0');
  return `${head}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

export const KIND = {
  user: 1,
  store: 2,
  member: 3,
  customer: 4,
  card: 5,
  auction: 6,
  bid: 7,
  settlement: 8,
  item: 9,
  shipment: 13,
  link: 14,
  request: 15,
  adminLog: 16,
  notification: 17,
  planRequest: 18,
  token: 10,
  invitation: 11,
  activity: 12,
} as const;

const money = (value: number): string => value.toFixed(2);
const at = (iso: string): Date => new Date(iso);

export const SEED_IDS = {
  userOwner: uid(KIND.user, 1),
  userStaff: uid(KIND.user, 2),
  userOtherOwner: uid(KIND.user, 3),
  userOtpExpired: uid(KIND.user, 4),
  userAdmin: uid(KIND.user, 5),
  userInvited: uid(KIND.user, 6),
  userSuspended: uid(KIND.user, 7),
  storeA: uid(KIND.store, 1),
  storeB: uid(KIND.store, 2),
  storeC: uid(KIND.store, 3),
} as const;

const TABLES_TO_CLEAR = [
  'notification_reads',
  'notifications',
  'plan_change_requests',
  'access_requests',
  'admin_activity_log',
  'public_links',
  'lgpd_consents',
  'public_ip_failures',
  'shipments',
  'activity_log',
  'invitations',
  'whatsapp_sessions',
  'settlement_items',
  'settlements',
  'bids',
  'auctions',
  'cards_inventory',
  'customers',
  'tcgdex_catalog',
  'store_members',
  'stores',
  'refresh_tokens',
  'users',
];

const CATALOG = [
  ['seed-001', 'Pikachu', '025/165', 'Pokémon 151', 'Common'],
  ['seed-002', 'Charizard ex', '006/165', 'Pokémon 151', 'Double Rare'],
  ['seed-003', 'Mew', '151/165', 'Pokémon 151', 'Rare'],
  ['seed-004', 'Flabébé', '083/198', 'Escarlate e Violeta', 'Common'],
  ['seed-005', 'Nidoran♀', '029/165', 'Pokémon 151', 'Common'],
  ['seed-006', 'Mr. Mime', '122/165', 'Pokémon 151', 'Uncommon'],
  ['seed-007', "Farfetch'd", '083/165', 'Pokémon 151', 'Uncommon'],
  ['seed-008', 'Gengar 👻', '094/165', 'Pokémon 151', 'Rare'],
  ['seed-009', 'Eevee', '133/165', 'Pokémon 151', 'Common'],
  ['seed-010', 'Snorlax', '143/165', 'Pokémon 151', 'Rare'],
  ['seed-011', 'Pokémon Açaí (promo)', 'SVP 001', 'Promo', 'Promo'],
  ['seed-012', 'Mewtwo', '150/165', 'Pokémon 151', 'Ultra Rare'],
] as const;

const CONDITIONS = ['MINT', 'NM', 'SP', 'MP', 'HP', 'DMG'] as const;
const LANGUAGES = ['PT', 'EN', 'JP', 'ES'] as const;

interface BidSpec {
  bidder: number;
  amount: number;
}

type CustomerRow = typeof schema.customers.$inferInsert;

const pad = (n: number, size: number): string => String(n).padStart(size, '0');

/** Loja A: 1-25 clientes completos (1-4 são consignadores), 26-37 visitantes, 38-40 na blacklist. */
function storeACustomer(n: number): CustomerRow {
  const isVisitor = n >= 26 && n <= 37;
  const isBlacklisted = n >= 38;
  const base: CustomerRow = {
    id: uid(KIND.customer, n),
    storeId: SEED_IDS.storeA,
    phone: `55119000${pad(n, 5)}`,
    name: n % 7 === 0 ? `João da Conceição 🎴 ${n}` : `Cliente ${pad(n, 2)}`,
    isVisitor,
    isBlacklisted,
    blacklistReason: isBlacklisted ? 'Calote em leilão anterior' : null,
    // Visitante de número par nunca interagiu depois do primeiro lance.
    lastInteractionAt:
      isVisitor && n % 2 === 0 ? null : at(`2026-10-${pad((n % 28) + 1, 2)}T15:00:00Z`),
  };
  if (isVisitor) return base;
  return {
    ...base,
    // Cliente de número múltiplo de 5 não informou e-mail.
    email: n % 5 === 0 ? null : `cliente${n}@example.com`,
    cpf: `000000${pad(n, 3)}00`,
    addressZip: '01310100',
    addressStreet: 'Avenida Paulista',
    addressNumber: String(n * 10),
    addressComp: n % 3 === 0 ? 'Apto 12' : null,
    addressCity: 'São Paulo',
    addressState: 'SP',
  };
}

/** Loja B: mesmo telefone dos primeiros clientes da loja A (único só dentro da loja). */
function storeBCustomer(n: number): CustomerRow {
  return {
    id: uid(KIND.customer, 100 + n),
    storeId: SEED_IDS.storeB,
    phone: `55119000${pad(n, 5)}`,
    name: `Cliente B${n}`,
    isVisitor: n > 3,
    email: n > 3 ? null : `b${n}@example.com`,
  };
}

function storeCCustomer(n: number): CustomerRow {
  return {
    id: uid(KIND.customer, 200 + n),
    storeId: SEED_IDS.storeC,
    phone: `55219000${pad(n, 5)}`,
    name: `Cliente C${n}`,
  };
}

const range = (size: number): number[] => Array.from({ length: size }, (_, i) => i + 1);

function buildCustomers(): CustomerRow[] {
  return [
    ...range(40).map(storeACustomer),
    ...range(5).map(storeBCustomer),
    ...range(2).map(storeCCustomer),
  ];
}

/** Cartas da loja A. Os números 1-60; as consignadas são as múltiplas de 5. */
function buildCardsStoreA(
  statusByCard: Map<number, (typeof schema.cardsInventory.$inferInsert)['status']>,
) {
  const rows: (typeof schema.cardsInventory.$inferInsert)[] = [];
  for (let n = 1; n <= 60; n += 1) {
    const consigned = n % 5 === 0;
    const catalog = CATALOG[n % CATALOG.length];
    rows.push({
      id: uid(KIND.card, n),
      storeId: SEED_IDS.storeA,
      shortCode: `A${n}`,
      tcgdexId: catalog?.[0] ?? 'seed-001',
      language: LANGUAGES[n % LANGUAGES.length] ?? 'PT',
      condition: CONDITIONS[n % CONDITIONS.length] ?? 'NM',
      isFoil: n % 3 === 0,
      notes: n % 4 === 0 ? 'Canto levemente marcado, ver foto' : null,
      customPhotos: Array.from(
        { length: n % 4 },
        (_, i) => `https://example.com/fotos/A${n}-${i + 1}.jpg`,
      ),
      ownershipType: consigned ? 'CONSIGNED' : 'OWN',
      consignorId: consigned ? uid(KIND.customer, ((n / 5 - 1) % 4) + 1) : null,
      storeCommissionPct: consigned ? money(10 + (n % 4) * 5) : null,
      status: statusByCard.get(n) ?? 'AVAILABLE',
    });
  }
  return rows;
}

export async function seedDatabase(pool: pg.Pool): Promise<void> {
  const db = drizzle({ client: pool, schema });

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`TRUNCATE ${TABLES_TO_CLEAR.join(', ')} RESTART IDENTITY CASCADE`));
    await insertAll(tx);
    await normalizeTimestamps(tx);
  });
}

const SEED_TIME = '2026-10-01T00:00:00Z';

/**
 * As colunas created_at/updated_at usam now() por padrão, o que mudaria a cada
 * execução. Fixá-las aqui é o que torna o seed realmente determinístico.
 */
async function normalizeTimestamps(db: Tx): Promise<void> {
  const created = [
    'users',
    'invitations',
    'activity_log',
    'refresh_tokens',
    'stores',
    'store_members',
    'customers',
    'cards_inventory',
    'auctions',
    'settlements',
    'shipments',
    'public_links',
    'lgpd_consents',
    'access_requests',
    'admin_activity_log',
    'notifications',
    'plan_change_requests',
  ];
  for (const table of created) {
    await db.execute(sql.raw(`UPDATE ${table} SET created_at = '${SEED_TIME}'`));
  }
  for (const table of [
    'customers',
    'cards_inventory',
    'tcgdex_catalog',
    'whatsapp_sessions',
    'shipments',
  ]) {
    await db.execute(sql.raw(`UPDATE ${table} SET updated_at = '${SEED_TIME}'`));
  }
  await db.execute(sql.raw(`UPDATE notification_reads SET read_at = '${SEED_TIME}'`));
}

async function insertAll(db: Tx): Promise<void> {
  // --- Identidade -------------------------------------------------------------
  await db.insert(schema.users).values([
    {
      // Dono de duas lojas; pode criar até 3 lojas por conta própria.
      id: SEED_IDS.userOwner,
      email: 'dono@example.com',
      name: 'Dono Demo',
      status: 'ACTIVE',
      canCreateStores: true,
      storeLimit: 3,
      lastLoginAt: at('2026-10-15T12:00:00Z'),
    },
    {
      id: SEED_IDS.userStaff,
      email: 'funcionario@example.com',
      name: 'Funcionária Demo',
      status: 'ACTIVE',
    },
    {
      id: SEED_IDS.userOtherOwner,
      email: 'outro-dono@example.com',
      name: 'Outro Dono',
      status: 'ACTIVE',
    },
    {
      // Código pedido e já expirado, com tentativas gastas.
      id: SEED_IDS.userOtpExpired,
      email: 'otp-expirado@example.com',
      status: 'ACTIVE',
      otpHash: 'seed-hash-nao-e-um-hash-real',
      otpExpiresAt: at('2026-01-01T00:00:00Z'),
      otpAttempts: 3,
    },
    {
      // Administrador da plataforma: não é membro de nenhuma loja.
      id: SEED_IDS.userAdmin,
      email: 'admin@example.com',
      name: 'Admin Demo',
      status: 'ACTIVE',
      isPlatformAdmin: true,
    },
    { id: SEED_IDS.userInvited, email: 'convidado@example.com', status: 'INVITED' },
    {
      id: SEED_IDS.userSuspended,
      email: 'suspenso@example.com',
      name: 'Usuário Suspenso',
      status: 'SUSPENDED',
    },
  ]);
  await db.insert(schema.refreshTokens).values([
    {
      id: uid(KIND.token, 1),
      userId: SEED_IDS.userOwner,
      tokenHash: 'seed-refresh-ativo',
      expiresAt: at('2099-01-01T00:00:00Z'),
    },
    {
      id: uid(KIND.token, 2),
      userId: SEED_IDS.userOwner,
      tokenHash: 'seed-refresh-revogado',
      expiresAt: at('2099-01-01T00:00:00Z'),
      revokedAt: at('2026-10-01T00:00:00Z'),
    },
  ]);

  await db.insert(schema.stores).values([
    {
      id: SEED_IDS.storeA,
      name: 'Cartas do Zé 🔥',
      whatsappGroupId: '120363000000000001@g.us',
      whatsappStatus: 'ONLINE',
      inactivityDaysLimit: 30,
      pixKey: 'pix@cartasdoze.example.com',
      city: 'São Paulo',
      cardLimit: 500,
    },
    {
      id: SEED_IDS.storeB,
      name: 'Pokémon Açaí',
      whatsappStatus: 'QR_READY',
      city: 'Curitiba',
      plan: 'PRO',
      memberLimit: 10,
      showcaseEnabled: true,
      whatsappInviteUrl: 'https://chat.whatsapp.com/ABCDEFGHIJKLMNOPQRSTUV',
    },
    { id: SEED_IDS.storeC, name: 'Loja Isolada', whatsappStatus: 'OFFLINE' },
  ]);
  await db.insert(schema.whatsappSessions).values({
    storeId: SEED_IDS.storeA,
    sessionData: 'seed-sessao-criptografada-placeholder',
  });
  await db.insert(schema.invitations).values([
    {
      // Convite de funcionário ainda pendente para o usuário `convidado`.
      id: uid(KIND.invitation, 1),
      tokenHash: 'seed-convite-pendente',
      email: 'convidado@example.com',
      storeId: SEED_IDS.storeA,
      role: 'STAFF',
      permissions: { can_delete: false },
      invitedBy: SEED_IDS.userOwner,
      expiresAt: at('2099-01-01T00:00:00Z'),
    },
    {
      id: uid(KIND.invitation, 2),
      tokenHash: 'seed-convite-aceito',
      email: 'funcionario@example.com',
      storeId: SEED_IDS.storeA,
      role: 'STAFF',
      permissions: { can_delete: false },
      invitedBy: SEED_IDS.userOwner,
      status: 'ACCEPTED',
      acceptedAt: at('2026-09-01T10:00:00Z'),
      expiresAt: at('2099-01-01T00:00:00Z'),
    },
    {
      id: uid(KIND.invitation, 3),
      tokenHash: 'seed-convite-revogado',
      email: 'revogado@example.com',
      storeId: SEED_IDS.storeB,
      role: 'STAFF',
      invitedBy: SEED_IDS.userOwner,
      status: 'REVOKED',
      expiresAt: at('2099-01-01T00:00:00Z'),
    },
    {
      // Pendente, mas vencido pelo relógio.
      id: uid(KIND.invitation, 4),
      tokenHash: 'seed-convite-expirado',
      email: 'expirado@example.com',
      storeId: SEED_IDS.storeA,
      role: 'STAFF',
      invitedBy: SEED_IDS.userOwner,
      expiresAt: at('2026-01-01T00:00:00Z'),
    },
    {
      // Convite só de conta (administrador cadastrando usuário, sem loja).
      id: uid(KIND.invitation, 5),
      tokenHash: 'seed-convite-so-conta',
      email: 'novo-lojista@example.com',
      invitedBy: SEED_IDS.userAdmin,
      expiresAt: at('2099-01-01T00:00:00Z'),
    },
  ]);
  await db.insert(schema.activityLog).values([
    {
      id: uid(KIND.activity, 1),
      storeId: SEED_IDS.storeA,
      actorUserId: SEED_IDS.userOwner,
      action: 'invitation.sent',
      targetType: 'invitation',
      targetId: uid(KIND.invitation, 1),
      details: { role: 'STAFF' },
    },
    {
      id: uid(KIND.activity, 2),
      storeId: SEED_IDS.storeA,
      actorUserId: SEED_IDS.userOwner,
      action: 'member.permissions_updated',
      targetType: 'member',
      targetId: uid(KIND.member, 3),
      details: { changed: ['can_manage_auctions'] },
    },
    {
      id: uid(KIND.activity, 3),
      storeId: SEED_IDS.storeB,
      actorUserId: SEED_IDS.userOwner,
      action: 'store.updated',
      targetType: 'store',
      targetId: SEED_IDS.storeB,
      details: { fields: ['name'] },
    },
  ]);
  await db.insert(schema.storeMembers).values([
    // O mesmo e-mail é dono de duas lojas (dados isolados entre elas).
    {
      id: uid(KIND.member, 1),
      storeId: SEED_IDS.storeA,
      userId: SEED_IDS.userOwner,
      role: 'OWNER',
      permissions: { can_delete: true, can_view_finance: true, can_manage_auctions: true },
    },
    {
      id: uid(KIND.member, 2),
      storeId: SEED_IDS.storeB,
      userId: SEED_IDS.userOwner,
      role: 'OWNER',
      permissions: { can_delete: true, can_view_finance: true, can_manage_auctions: true },
    },
    {
      id: uid(KIND.member, 3),
      storeId: SEED_IDS.storeA,
      userId: SEED_IDS.userStaff,
      role: 'STAFF',
      permissions: { can_delete: false, can_view_finance: false, can_manage_auctions: true },
    },
    {
      id: uid(KIND.member, 4),
      storeId: SEED_IDS.storeC,
      userId: SEED_IDS.userOtherOwner,
      role: 'OWNER',
      permissions: { can_delete: true },
    },
  ]);

  // --- Catálogo e clientes ----------------------------------------------------
  await db.insert(schema.tcgdexCatalog).values(
    CATALOG.map(([id, name, cardNumber, setName, rarity]) => {
      const setId = 'sv03.5';
      const localId = cardNumber.split('/')[0] ?? cardNumber;
      return {
        id,
        name,
        cardNumber: localId,
        setName,
        setId,
        searchText: buildSearchText({ names: [name], localId, setNames: [setName], setId }),
        // Mesmo formato que o sync grava; a raridade já vem preenchida no seed.
        rawData: {
          names: { en: name },
          images: { en: `https://assets.tcgdex.net/en/sv/${setId}/${localId}` },
          rarity,
        },
      };
    }),
  );
  await db.insert(schema.customers).values(buildCustomers());

  // --- Estoque da loja A: o status final de cada carta depende dos leilões ----
  const cardStatus = new Map<number, (typeof schema.cardsInventory.$inferInsert)['status']>([
    [1, 'SCHEDULED'], // PENDING
    [2, 'SCHEDULED'], // ACTIVE lance livre
    [3, 'SCHEDULED'], // ACTIVE enquete
    [4, 'SCHEDULED'], // enquete no teto, aguardando validação
    [6, 'SOLD'], // acerto pago
    [7, 'AWAITING_CONFIRMATION'], // acerto pendente
    [8, 'AWAITING_CONFIRMATION'], // acerto pendente
    [9, 'AWAITING_CONFIRMATION'], // vencedor visitante, sem acerto
    [31, 'SOLD'], // acerto pago, envio a enviar
    [32, 'SOLD'], // acerto pago, envio entregue
  ]);
  await db.insert(schema.cardsInventory).values(buildCardsStoreA(cardStatus));

  // Lojas B e C: poucas cartas, com os mesmos short codes da loja A.
  await db.insert(schema.cardsInventory).values([
    ...Array.from({ length: 8 }, (_, i) => ({
      id: uid(KIND.card, 1000 + i),
      storeId: SEED_IDS.storeB,
      shortCode: `A${i + 1}`,
      tcgdexId: CATALOG[i]?.[0] ?? 'seed-001',
      language: 'EN',
      condition: CONDITIONS[i % CONDITIONS.length] ?? 'NM',
      ownershipType: 'OWN' as const,
      status: i === 0 ? ('SCHEDULED' as const) : ('AVAILABLE' as const),
    })),
    ...Array.from({ length: 2 }, (_, i) => ({
      id: uid(KIND.card, 2000 + i),
      storeId: SEED_IDS.storeC,
      shortCode: `C${i + 1}`,
      tcgdexId: 'seed-002',
      language: 'JP',
      condition: 'MINT' as const,
      ownershipType: 'OWN' as const,
    })),
  ]);

  await insertAuctions(db);
}

interface AuctionSpec {
  n: number;
  storeId: string;
  card: string;
  type: 'FREE_BID' | 'POLL';
  status: (typeof schema.auctions.$inferInsert)['status'];
  start: string;
  end: string;
  initial: number;
  increment: number;
  ceiling?: number;
  alert?: boolean;
  bids: BidSpec[];
  /** Quem venceu (índice em `bids`). Ausente = sem vencedor. */
  winner?: number;
}

function ladder(bidders: number[], first: number, step: number): BidSpec[] {
  return bidders.map((bidder, i) => ({ bidder, amount: first + i * step }));
}

async function insertAuctions(db: Tx): Promise<void> {
  const A = SEED_IDS.storeA;
  const specs: AuctionSpec[] = [
    {
      n: 1,
      storeId: A,
      card: uid(KIND.card, 1),
      type: 'FREE_BID',
      status: 'PENDING',
      start: '2098-01-01T12:00:00Z',
      end: '2098-01-02T12:00:00Z',
      initial: 10,
      increment: 2,
      bids: [],
    },
    {
      n: 2,
      storeId: A,
      card: uid(KIND.card, 2),
      type: 'FREE_BID',
      status: 'ACTIVE',
      start: '2026-10-01T12:00:00Z',
      end: '2099-01-01T12:00:00Z',
      initial: 20,
      increment: 5,
      bids: ladder([5, 6, 28, 7, 9], 20, 5),
    },
    {
      n: 3,
      storeId: A,
      card: uid(KIND.card, 3),
      type: 'POLL',
      status: 'ACTIVE',
      start: '2026-10-01T12:00:00Z',
      end: '2099-01-01T12:00:00Z',
      initial: 30,
      increment: 10,
      ceiling: 200,
      bids: ladder([10, 11], 30, 10),
    },
    {
      n: 4,
      storeId: A,
      card: uid(KIND.card, 4),
      type: 'POLL',
      status: 'PAUSED_FOR_VALIDATION',
      start: '2026-10-01T12:00:00Z',
      end: '2099-01-01T12:00:00Z',
      initial: 50,
      increment: 25,
      ceiling: 150,
      alert: true,
      bids: ladder([12, 13, 14], 50, 50),
    },
    // Encerrado e pago: o vencedor é o cliente 15.
    {
      n: 5,
      storeId: A,
      card: uid(KIND.card, 6),
      type: 'FREE_BID',
      status: 'FINISHED',
      start: '2026-09-01T12:00:00Z',
      end: '2026-09-02T12:00:00Z',
      initial: 15,
      increment: 5,
      bids: ladder([16, 15], 15, 5),
      winner: 1,
    },
    // Dois encerrados do mesmo cliente 17, no mesmo acerto pendente.
    {
      n: 6,
      storeId: A,
      card: uid(KIND.card, 7),
      type: 'FREE_BID',
      status: 'FINISHED',
      start: '2026-09-10T12:00:00Z',
      end: '2026-09-11T12:00:00Z',
      initial: 40,
      increment: 10,
      bids: ladder([18, 17], 40, 10),
      winner: 1,
    },
    {
      n: 7,
      storeId: A,
      card: uid(KIND.card, 8),
      type: 'POLL',
      status: 'FINISHED',
      start: '2026-09-10T12:00:00Z',
      end: '2026-09-11T13:00:00Z',
      initial: 25,
      increment: 5,
      ceiling: 60,
      bids: ladder([17], 60, 0),
      winner: 0,
    },
    // Vencedor visitante (cliente 30): ainda precisa virar cliente completo.
    {
      n: 8,
      storeId: A,
      card: uid(KIND.card, 9),
      type: 'FREE_BID',
      status: 'FINISHED',
      start: '2026-09-12T12:00:00Z',
      end: '2026-09-13T12:00:00Z',
      initial: 12,
      increment: 3,
      bids: ladder([30], 12, 0),
      winner: 0,
    },
    // Encerrado sem lances: a carta volta ao estoque.
    {
      n: 9,
      storeId: A,
      card: uid(KIND.card, 10),
      type: 'FREE_BID',
      status: 'FINISHED',
      start: '2026-09-14T12:00:00Z',
      end: '2026-09-15T12:00:00Z',
      initial: 12,
      increment: 3,
      bids: [],
    },
    // Cancelado, com um lance de quem hoje está na blacklist (cliente 38).
    {
      n: 10,
      storeId: A,
      card: uid(KIND.card, 11),
      type: 'FREE_BID',
      status: 'CANCELLED',
      start: '2026-09-16T12:00:00Z',
      end: '2026-09-17T12:00:00Z',
      initial: 12,
      increment: 3,
      bids: [{ bidder: 38, amount: 99 }],
    },
    // Mais duas vendas pagas, para o envio ter os três estados.
    {
      n: 12,
      storeId: A,
      card: uid(KIND.card, 31),
      type: 'FREE_BID',
      status: 'FINISHED',
      start: '2026-09-18T12:00:00Z',
      end: '2026-09-19T12:00:00Z',
      initial: 10,
      increment: 5,
      bids: ladder([19], 30, 0),
      winner: 0,
    },
    {
      n: 13,
      storeId: A,
      card: uid(KIND.card, 32),
      type: 'FREE_BID',
      status: 'FINISHED',
      start: '2026-09-20T12:00:00Z',
      end: '2026-09-21T12:00:00Z',
      initial: 10,
      increment: 5,
      bids: ladder([20], 45, 0),
      winner: 0,
    },
    // Loja B: uma enquete em andamento.
    {
      n: 11,
      storeId: SEED_IDS.storeB,
      card: uid(KIND.card, 1000),
      type: 'POLL',
      status: 'ACTIVE',
      start: '2026-10-01T12:00:00Z',
      end: '2099-01-01T12:00:00Z',
      initial: 10,
      increment: 5,
      ceiling: 100,
      bids: ladder([101, 102], 10, 5),
    },
  ];

  await db.insert(schema.auctions).values(
    specs.map((s) => ({
      id: uid(KIND.auction, s.n),
      storeId: s.storeId,
      cardId: s.card,
      type: s.type,
      status: s.status,
      startTime: at(s.start),
      endTime: at(s.end),
      initialBid: money(s.initial),
      minIncrement: money(s.increment),
      maxPollValue: s.ceiling === undefined ? null : money(s.ceiling),
      maxValueReachedAlert: s.alert ?? false,
    })),
  );

  const bidRows: (typeof schema.bids.$inferInsert)[] = [];
  specs.forEach((s) => {
    s.bids.forEach((bid, i) => {
      bidRows.push({
        id: uid(KIND.bid, s.n * 100 + i),
        storeId: s.storeId,
        auctionId: uid(KIND.auction, s.n),
        customerId: uid(KIND.customer, bid.bidder),
        amount: money(bid.amount),
        rawWhatsappMessage: i % 2 === 0 ? `#A${s.n} ${bid.amount}` : `#A${s.n} R$ ${bid.amount},00`,
        createdAt: at(`2026-09-${String(10 + i).padStart(2, '0')}T10:00:0${i}Z`),
      });
    });
  });
  await db.insert(schema.bids).values(bidRows);

  for (const s of specs) {
    if (s.winner !== undefined) {
      await db
        .update(schema.auctions)
        .set({ winningBidId: uid(KIND.bid, s.n * 100 + s.winner) })
        .where(eq(schema.auctions.id, uid(KIND.auction, s.n)));
    }
  }

  await insertSettlements(db);
  await insertPublicLinks(db);
  await insertAdministration(db);
  await insertPlansAndNotifications(db);
}

/**
 * Tokens FIXOS, só para desenvolvimento (43 caracteres, como os reais). Nunca existem em produção: o
 * seed recusa rodar fora de local, dev e test.
 */
export const SEED_LINK_TOKENS = {
  settlement: 'dev-settlement-link-token'.padEnd(43, 'A'),
  revokedSettlement: 'dev-revoked-link-token'.padEnd(43, 'B'),
  consignor: 'dev-consignor-link-token'.padEnd(43, 'C'),
} as const;

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** Pedidos de plano nos três estados, notificações (lidas e não lidas) e uma preferência fora do padrão. */
async function insertPlansAndNotifications(db: Tx): Promise<void> {
  await db.insert(schema.planChangeRequests).values([
    {
      id: uid(KIND.planRequest, 1),
      storeId: SEED_IDS.storeA,
      requestedPlan: 'PRO',
      message: 'Queremos mais membros na equipe.',
      requestedBy: SEED_IDS.userOwner,
    },
    {
      id: uid(KIND.planRequest, 2),
      storeId: SEED_IDS.storeB,
      requestedPlan: 'PRO',
      status: 'APPLIED',
      requestedBy: SEED_IDS.userOwner,
      decidedBy: SEED_IDS.userAdmin,
      decidedAt: at('2026-09-15T12:00:00Z'),
    },
    {
      id: uid(KIND.planRequest, 3),
      storeId: SEED_IDS.storeC,
      requestedPlan: 'ENTERPRISE',
      status: 'REFUSED',
      requestedBy: SEED_IDS.userOtherOwner,
      decidedBy: SEED_IDS.userAdmin,
      decidedAt: at('2026-09-16T12:00:00Z'),
    },
  ]);

  const A = SEED_IDS.storeA;
  await db.insert(schema.notifications).values([
    {
      id: uid(KIND.notification, 1),
      storeId: A,
      kind: 'POLL_CEILING_REACHED',
      data: { auction_id: uid(KIND.auction, 4) },
    },
    {
      id: uid(KIND.notification, 2),
      storeId: A,
      kind: 'BUYER_DATA_SUBMITTED',
      data: { settlement_id: uid(KIND.settlement, 2), customer_id: uid(KIND.customer, 17) },
    },
    {
      id: uid(KIND.notification, 3),
      storeId: SEED_IDS.storeB,
      kind: 'POLL_CEILING_REACHED',
      data: { auction_id: uid(KIND.auction, 11) },
    },
  ]);
  // O dono já leu a primeira; o funcionário não leu nenhuma.
  await db.insert(schema.notificationReads).values({
    notificationId: uid(KIND.notification, 1),
    storeId: A,
    userId: SEED_IDS.userOwner,
  });
  await db
    .update(schema.users)
    .set({ language: 'en', theme: 'DARK', timezone: 'America/Manaus' })
    .where(eq(schema.users.id, SEED_IDS.userStaff));
}

const sha256Hex = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/** Solicitações de acesso nos três estados e uma entrada no log da plataforma. */
async function insertAdministration(db: Tx): Promise<void> {
  await db.insert(schema.accessRequests).values([
    {
      id: uid(KIND.request, 1),
      name: 'Gary Oak',
      email: 'gary@example.com',
      whatsapp: '5511988880001',
      storeName: 'Cartas do Gary',
      message: 'Vendo cartas há 3 anos em grupos de WhatsApp.',
      ipHash: sha256Hex('203.0.113.1'),
    },
    {
      id: uid(KIND.request, 2),
      name: 'Team Rocket',
      email: 'rocket@example.com',
      storeName: 'Loja suspeita',
      status: 'REFUSED',
      ipHash: sha256Hex('203.0.113.2'),
      decidedBy: SEED_IDS.userAdmin,
      decidedAt: at('2026-09-30T12:00:00Z'),
    },
    {
      id: uid(KIND.request, 3),
      name: 'Dono da Loja Isolada',
      email: 'outro-dono@example.com',
      storeName: 'Loja Isolada',
      status: 'CONVERTED',
      ipHash: sha256Hex('203.0.113.3'),
      decidedBy: SEED_IDS.userAdmin,
      decidedAt: at('2026-09-01T12:00:00Z'),
      convertedStoreId: SEED_IDS.storeC,
    },
  ]);
  await db.insert(schema.adminActivityLog).values({
    id: uid(KIND.adminLog, 1),
    actorUserId: SEED_IDS.userAdmin,
    action: 'store.created',
    targetType: 'store',
    targetId: SEED_IDS.storeC,
    details: { access_request_id: uid(KIND.request, 3) },
  });
}

async function insertPublicLinks(db: Tx): Promise<void> {
  const A = SEED_IDS.storeA;
  await db.insert(schema.publicLinks).values([
    // Acerto pendente do cliente 17.
    {
      id: uid(KIND.link, 1),
      storeId: A,
      kind: 'SETTLEMENT',
      settlementId: uid(KIND.settlement, 2),
      tokenHash: sha256(SEED_LINK_TOKENS.settlement),
      expiresAt: at('2098-01-01T00:00:00Z'),
      createdBy: SEED_IDS.userOwner,
    },
    // Revogado.
    {
      id: uid(KIND.link, 2),
      storeId: A,
      kind: 'SETTLEMENT',
      settlementId: uid(KIND.settlement, 1),
      tokenHash: sha256(SEED_LINK_TOKENS.revokedSettlement),
      expiresAt: at('2098-01-01T00:00:00Z'),
      revokedAt: at('2026-09-10T00:00:00Z'),
      createdBy: SEED_IDS.userOwner,
    },
    // Consignador (cliente 1: a chave são os 4 primeiros dígitos do CPF, "0000").
    {
      id: uid(KIND.link, 3),
      storeId: A,
      kind: 'CONSIGNOR',
      customerId: uid(KIND.customer, 1),
      tokenHash: sha256(SEED_LINK_TOKENS.consignor),
      expiresAt: at('2098-01-01T00:00:00Z'),
      createdBy: SEED_IDS.userOwner,
    },
  ]);
}

async function insertSettlements(db: Tx): Promise<void> {
  const A = SEED_IDS.storeA;
  await db.insert(schema.settlements).values([
    // Pago: 20 do leilão 5 + 25,50 de frete.
    {
      id: uid(KIND.settlement, 1),
      storeId: A,
      customerId: uid(KIND.customer, 15),
      shippingCost: money(25.5),
      totalAmount: money(45.5),
      status: 'PAID',
      paidAt: at('2026-09-05T18:30:00Z'),
    },
    // Pendente com dois itens, sem frete informado ainda: 50 + 60.
    {
      id: uid(KIND.settlement, 2),
      storeId: A,
      customerId: uid(KIND.customer, 17),
      shippingCost: money(0),
      totalAmount: money(110),
      status: 'PENDING',
    },
    // Pagos, com envio: a enviar (cliente 19) e entregue (cliente 20).
    {
      id: uid(KIND.settlement, 3),
      storeId: A,
      customerId: uid(KIND.customer, 19),
      shippingCost: money(20),
      totalAmount: money(50),
      status: 'PAID',
      paidAt: at('2026-09-22T18:00:00Z'),
    },
    {
      id: uid(KIND.settlement, 4),
      storeId: A,
      customerId: uid(KIND.customer, 20),
      shippingCost: money(0),
      totalAmount: money(45),
      status: 'PAID',
      paidAt: at('2026-09-23T18:00:00Z'),
    },
  ]);
  await db.insert(schema.settlementItems).values([
    {
      id: uid(KIND.item, 4),
      storeId: A,
      settlementId: uid(KIND.settlement, 3),
      auctionId: uid(KIND.auction, 12),
      cardId: uid(KIND.card, 31),
      amount: money(30),
    },
    {
      id: uid(KIND.item, 5),
      storeId: A,
      settlementId: uid(KIND.settlement, 4),
      auctionId: uid(KIND.auction, 13),
      cardId: uid(KIND.card, 32),
      amount: money(45),
    },
    {
      id: uid(KIND.item, 1),
      storeId: A,
      settlementId: uid(KIND.settlement, 1),
      auctionId: uid(KIND.auction, 5),
      cardId: uid(KIND.card, 6),
      amount: money(20),
    },
    {
      id: uid(KIND.item, 2),
      storeId: A,
      settlementId: uid(KIND.settlement, 2),
      auctionId: uid(KIND.auction, 6),
      cardId: uid(KIND.card, 7),
      amount: money(50),
    },
    {
      id: uid(KIND.item, 3),
      storeId: A,
      settlementId: uid(KIND.settlement, 2),
      auctionId: uid(KIND.auction, 7),
      cardId: uid(KIND.card, 8),
      amount: money(60),
    },
  ]);
  await db.insert(schema.shipments).values([
    // Cliente 15 (acerto 1): enviado, com rastreio.
    {
      id: uid(KIND.shipment, 1),
      storeId: A,
      settlementId: uid(KIND.settlement, 1),
      status: 'SHIPPED',
      trackingCode: 'AA123456789BR',
      shippedAt: at('2026-09-06T12:00:00Z'),
    },
    // Cliente 19 (acerto 3): ainda a enviar.
    { id: uid(KIND.shipment, 2), storeId: A, settlementId: uid(KIND.settlement, 3) },
    // Cliente 20 (acerto 4): entregue.
    {
      id: uid(KIND.shipment, 3),
      storeId: A,
      settlementId: uid(KIND.settlement, 4),
      status: 'DELIVERED',
      trackingCode: 'BB987654321BR',
      shippedAt: at('2026-09-24T12:00:00Z'),
      deliveredAt: at('2026-09-28T15:00:00Z'),
    },
  ]);
}
