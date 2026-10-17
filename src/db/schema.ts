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

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const money = (name: string) => numeric(name, { precision: 12, scale: 2 });

// --- Identidade (0002) -------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique('users_email_key'),
  otpHash: text('otp_hash'),
  otpExpiresAt: timestamp('otp_expires_at', { withTimezone: true }),
  otpAttempts: integer('otp_attempts').notNull().default(0),
  createdAt: createdAt(),
});

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
    createdAt: createdAt(),
  },
  (t) => [index('refresh_tokens_user_id_idx').on(t.userId)],
);

export const stores = pgTable('stores', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Credencial da sessão do WhatsApp, guardada CRIPTOGRAFADA (ADR 0007). */
  whatsappSessionData: text('whatsapp_session_data'),
  whatsappGroupId: text('whatsapp_group_id'),
  whatsappStatus: whatsappStatus('whatsapp_status').notNull().default('OFFLINE'),
  inactivityDaysLimit: integer('inactivity_days_limit'),
  createdAt: createdAt(),
});

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
    rawData: jsonb('raw_data').$type<Record<string, unknown>>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
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
