// Schema do Drizzle: fonte dos TIPOS do banco (docs/database.md).
//
// O SQL real vive em migrations/NNNN_nome/{up,down}.sql e este arquivo acompanha
// cada migration no mesmo PR. test/schema-drift.integration.test.ts falha se as
// colunas daqui divergirem do banco migrado.
//
// Só existem SOMENTE no SQL (não aparecem aqui): CHECKs, índices parciais, a FK
// composta de auctions.winning_bid_id (referência circular com bids) e a
// extensão pg_trgm.
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// --- Enums -------------------------------------------------------------------
export const storeRole = pgEnum('store_role', ['OWNER', 'STAFF']);
export const whatsappStatus = pgEnum('whatsapp_status', ['ONLINE', 'OFFLINE', 'QR_READY']);
export const cardCondition = pgEnum('card_condition', ['MINT', 'NM', 'SP', 'MP', 'HP', 'DMG']);
export const ownershipType = pgEnum('ownership_type', ['OWN', 'CONSIGNED']);
export const cardStatus = pgEnum('card_status', [
  'AVAILABLE',
  'SCHEDULED',
  'AWAITING_CONFIRMATION',
  'SOLD',
]);
export const auctionType = pgEnum('auction_type', ['FREE_BID', 'POLL']);
export const auctionStatus = pgEnum('auction_status', [
  'PENDING',
  'ACTIVE',
  'PAUSED_FOR_VALIDATION',
  'FINISHED',
  'CANCELLED',
]);
export const settlementStatus = pgEnum('settlement_status', ['PENDING', 'PAID']);
export const shipmentStatus = pgEnum('shipment_status', ['TO_SHIP', 'SHIPPED', 'DELIVERED']);
export const userStatus = pgEnum('user_status', ['INVITED', 'ACTIVE', 'SUSPENDED']);
export const invitationStatus = pgEnum('invitation_status', ['PENDING', 'ACCEPTED', 'REVOKED']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 12, scale: 2 });

// --- Identidade (0002) -------------------------------------------------------
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique('users_email_key'),
    name: text('name'),
    /** Conta nasce `INVITED` e vira `ACTIVE` ao aceitar o convite (ADR 0012). */
    status: userStatus('status').notNull().default('INVITED'),
    /** Concedido só por comando de linha, nunca por API. */
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    canCreateStores: boolean('can_create_stores').notNull().default(false),
    storeLimit: integer('store_limit').notNull().default(0),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    /** Hash HMAC do OTP; o código nunca é guardado. */
    otpHash: text('otp_hash'),
    otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }),
    otpAttempts: integer('otp_attempts').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('users_status_idx').on(t.status)],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique('refresh_tokens_token_hash_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('refresh_tokens_user_id_idx').on(t.userId)],
);

export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  whatsappGroupId: text('whatsapp_group_id'),
  whatsappStatus: whatsappStatus('whatsapp_status').notNull().default('OFFLINE'),
  inactivityDaysLimit: integer('inactivity_days_limit'),
  createdAt: createdAt(),
});

/** Credencial da sessão do WhatsApp, CRIPTOGRAFADA (ADR 0007). Só o contexto da própria loja a enxerga. */
export const whatsappSessions = pgTable('whatsapp_sessions', {
  storeId: uuid('store_id')
    .primaryKey()
    .references(() => stores.id, { onDelete: 'cascade' }),
  sessionData: text('session_data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Convite de proprietário ou do administrador. Guarda só o hash do token (ADR 0012). */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenHash: text('token_hash').notNull().unique('invitations_token_hash_key'),
    email: text('email').notNull(),
    /** Vazio, junto com `role`, = convite só de conta. */
    storeId: uuid('store_id').references(() => stores.id, { onDelete: 'cascade' }),
    role: storeRole('role'),
    permissions: jsonb('permissions').$type<StorePermissions>().notNull().default({}),
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    status: invitationStatus('status').notNull().default('PENDING'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('invitations_email_idx').on(t.email)],
);

/** Ex.: { can_delete: false, can_view_finance: true, can_manage_auctions: true }. */
export type StorePermissions = Record<string, boolean>;

export const storeMembers = pgTable(
  'store_members',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: storeRole('role').notNull(),
    permissions: jsonb('permissions')
      .$type<StorePermissions>()
      .notNull()
      .default({ can_delete: false }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('store_members_store_user_key').on(t.storeId, t.userId),
    index('store_members_user_id_idx').on(t.userId),
  ],
);

// --- Catálogo TCGdex (0003): global, sem store_id (ADR 0009) -----------------
export const tcgdexCatalog = pgTable(
  'tcgdex_catalog',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    cardNumber: text('card_number').notNull(),
    setName: text('set_name').notNull(),
    setId: text('set_id'),
    /** Nomes, número, coleção e id, em minúsculas e sem acento (src/catalog/normalize.ts). */
    searchText: text('search_text').notNull().default(''),
    rawData: jsonb('raw_data').$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tcgdex_catalog_search_trgm_idx').using('gin', t.searchText.op('gin_trgm_ops')),
    index('tcgdex_catalog_set_id_idx').on(t.setId),
    index('tcgdex_catalog_name_trgm_idx').using('gin', t.name.op('gin_trgm_ops')),
    index('tcgdex_catalog_card_number_trgm_idx').using('gin', t.cardNumber.op('gin_trgm_ops')),
  ],
);

// --- Clientes (0004) ---------------------------------------------------------
export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    name: text('name').notNull(),
    email: text('email'),
    cpf: text('cpf'),
    isVisitor: boolean('is_visitor').notNull().default(true),
    isBlacklisted: boolean('is_blacklisted').notNull().default(false),
    blacklistReason: text('blacklist_reason'),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true }),
    addressZip: text('address_zip'),
    addressStreet: text('address_street'),
    addressNumber: text('address_number'),
    addressComp: text('address_comp'),
    addressCity: text('address_city'),
    addressState: text('address_state'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('customers_store_phone_key').on(t.storeId, t.phone),
    unique('customers_id_store_key').on(t.id, t.storeId),
    index('customers_store_last_interaction_idx').on(t.storeId, t.lastInteractionAt),
  ],
);

// --- Estoque (0005) ----------------------------------------------------------
export const cardsInventory = pgTable(
  'cards_inventory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    /** ID curto SEM o '#': o '#' é só o prefixo da mensagem no grupo (ADR 0003). */
    shortCode: text('short_code').notNull(),
    tcgdexId: text('tcgdex_id')
      .notNull()
      .references(() => tcgdexCatalog.id),
    language: text('language').notNull(),
    condition: cardCondition('condition').notNull(),
    isFoil: boolean('is_foil').notNull().default(false),
    customPhotos: jsonb('custom_photos').$type<string[]>().notNull().default([]),
    /** Observações da loja sobre a carta física (até 2000 caracteres). */
    notes: text('notes'),
    ownershipType: ownershipType('ownership_type').notNull(),
    consignorId: uuid('consignor_id'),
    storeCommissionPct: numeric('store_commission_pct', { precision: 5, scale: 2 }),
    status: cardStatus('status').notNull().default('AVAILABLE'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('cards_inventory_store_short_code_key').on(t.storeId, t.shortCode),
    unique('cards_inventory_id_store_key').on(t.id, t.storeId),
    foreignKey({
      name: 'cards_inventory_consignor_fkey',
      columns: [t.consignorId, t.storeId],
      foreignColumns: [customers.id, customers.storeId],
    }),
    index('cards_inventory_store_status_idx').on(t.storeId, t.status),
    index('cards_inventory_tcgdex_id_idx').on(t.tcgdexId),
  ],
);

// --- Leilões (0006) ----------------------------------------------------------
export const auctions = pgTable(
  'auctions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id').notNull(),
    type: auctionType('type').notNull(),
    startTime: timestamp('start_time', { withTimezone: true }).notNull(),
    endTime: timestamp('end_time', { withTimezone: true }).notNull(),
    initialBid: money('initial_bid').notNull(),
    minIncrement: money('min_increment').notNull(),
    maxPollValue: money('max_poll_value'),
    maxValueReachedAlert: boolean('max_value_reached_alert').notNull().default(false),
    /** FK composta (winning_bid_id, store_id) → bids só existe no SQL. */
    winningBidId: uuid('winning_bid_id'),
    status: auctionStatus('status').notNull().default('PENDING'),
    createdAt: createdAt(),
  },
  (t) => [
    unique('auctions_id_store_key').on(t.id, t.storeId),
    foreignKey({
      name: 'auctions_card_fkey',
      columns: [t.cardId, t.storeId],
      foreignColumns: [cardsInventory.id, cardsInventory.storeId],
    }),
    index('auctions_store_status_start_idx').on(t.storeId, t.status, t.startTime),
    index('auctions_status_start_idx').on(t.status, t.startTime),
    index('auctions_status_end_idx').on(t.status, t.endTime),
  ],
);

export const bids = pgTable(
  'bids',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    auctionId: uuid('auction_id').notNull(),
    customerId: uuid('customer_id').notNull(),
    amount: money('amount').notNull(),
    /** Mensagem original do grupo. Pode conter dado pessoal (LGPD). */
    rawWhatsappMessage: text('raw_whatsapp_message').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('bids_id_store_key').on(t.id, t.storeId),
    unique('bids_auction_amount_key').on(t.auctionId, t.amount),
    foreignKey({
      name: 'bids_auction_fkey',
      columns: [t.auctionId, t.storeId],
      foreignColumns: [auctions.id, auctions.storeId],
    }),
    foreignKey({
      name: 'bids_customer_fkey',
      columns: [t.customerId, t.storeId],
      foreignColumns: [customers.id, customers.storeId],
    }),
    index('bids_customer_created_idx').on(t.customerId, t.createdAt),
    index('bids_store_created_idx').on(t.storeId, t.createdAt),
  ],
);

// --- Acertos (0007) ----------------------------------------------------------
export const settlements = pgTable(
  'settlements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    shippingCost: money('shipping_cost').notNull().default('0'),
    totalAmount: money('total_amount').notNull(),
    status: settlementStatus('status').notNull().default('PENDING'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('settlements_id_store_key').on(t.id, t.storeId),
    foreignKey({
      name: 'settlements_customer_fkey',
      columns: [t.customerId, t.storeId],
      foreignColumns: [customers.id, customers.storeId],
    }),
    index('settlements_store_status_idx').on(t.storeId, t.status),
    index('settlements_customer_idx').on(t.customerId),
  ],
);

export const settlementItems = pgTable(
  'settlement_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    settlementId: uuid('settlement_id').notNull(),
    auctionId: uuid('auction_id').notNull(),
    cardId: uuid('card_id').notNull(),
    amount: money('amount').notNull(),
  },
  (t) => [
    unique('settlement_items_auction_key').on(t.auctionId),
    foreignKey({
      name: 'settlement_items_settlement_fkey',
      columns: [t.settlementId, t.storeId],
      foreignColumns: [settlements.id, settlements.storeId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'settlement_items_auction_fkey',
      columns: [t.auctionId, t.storeId],
      foreignColumns: [auctions.id, auctions.storeId],
    }),
    foreignKey({
      name: 'settlement_items_card_fkey',
      columns: [t.cardId, t.storeId],
      foreignColumns: [cardsInventory.id, cardsInventory.storeId],
    }),
    index('settlement_items_settlement_idx').on(t.settlementId),
  ],
);

// --- Envios (0014) -----------------------------------------------------------
export const shipments = pgTable(
  'shipments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    settlementId: uuid('settlement_id').notNull(),
    status: shipmentStatus('status').notNull().default('TO_SHIP'),
    trackingCode: text('tracking_code'),
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('shipments_id_store_key').on(t.id, t.storeId),
    unique('shipments_settlement_key').on(t.settlementId),
    foreignKey({
      name: 'shipments_settlement_fkey',
      columns: [t.settlementId, t.storeId],
      foreignColumns: [settlements.id, settlements.storeId],
    }),
    index('shipments_store_status_idx').on(t.storeId, t.status),
  ],
);

// --- Log de atividades (0010) ---------------------------------------------------
/** Imutável para a aplicação (só INSERT e SELECT) e legível só pelo proprietário. */
export const activityLog = pgTable(
  'activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Ex.: `store.updated`, `member.removed`, `invitation.sent`. */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    /** Só identificadores e valores técnicos: sem e-mail, telefone ou CPF. */
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('activity_log_store_created_idx').on(t.storeId, t.createdAt, t.id)],
);

// --- Execuções do sync do catálogo (0011) ---------------------------------------------
export const catalogSyncRuns = pgTable(
  'catalog_sync_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    source: text('source').notNull(),
    languages: text('languages').array().notNull(),
    /** `RUNNING`, `OK` ou `FAILED`. */
    status: text('status').notNull().default('RUNNING'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    cardsSeen: integer('cards_seen'),
    cardsInserted: integer('cards_inserted'),
    cardsUpdated: integer('cards_updated'),
    cardsSkipped: integer('cards_skipped'),
    /** Mensagem curta, sem payload. */
    error: text('error'),
  },
  (t) => [index('catalog_sync_runs_started_idx').on(t.startedAt)],
);
