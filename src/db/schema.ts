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
  inet,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
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
export const planRequestStatus = pgEnum('plan_request_status', ['PENDING', 'APPLIED', 'REFUSED']);
export const accessRequestStatus = pgEnum('access_request_status', [
  'PENDING',
  'REFUSED',
  'CONVERTED',
]);
export const publicLinkKind = pgEnum('public_link_kind', ['SETTLEMENT', 'CONSIGNOR']);
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
    /** Preferências do perfil. Só `pt-BR` e `en`; moeda só `BRL` por enquanto. */
    language: text('language').notNull().default('pt-BR'),
    theme: text('theme').notNull().default('SYSTEM'),
    timezone: text('timezone').notNull().default('America/Sao_Paulo'),
    currency: text('currency').notNull().default('BRL'),
    notificationPrefs: jsonb('notification_prefs')
      .$type<{ in_app: boolean; email: boolean }>()
      .notNull()
      .default({ in_app: true, email: false }),
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
  /** Chave PIX mostrada ao comprador na página do acerto. */
  pixKey: text('pix_key'),
  city: text('city'),
  /** Plano definido pela administração (não há autoatendimento). */
  plan: text('plan').notNull().default('STANDARD'),
  memberLimit: integer('member_limit').notNull().default(5),
  /** Sem valor = ilimitado. Definido pela administração junto com o plano. */
  cardLimit: integer('card_limit'),
  /** Opt-in da vitrine pública (ADR 0014): o link do grupo passa a ser público. */
  showcaseEnabled: boolean('showcase_enabled').notNull().default(false),
  whatsappInviteUrl: text('whatsapp_invite_url'),
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

/** Modelos de mensagem do bot por loja (0023). Sem linha, vale o padrão. */
export const storeMessageTemplates = pgTable(
  'store_message_templates',
  {
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    body: text('body').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.key] })],
);

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
    /** CPF cifrado (`v1.<iv>.<tag>.<texto>`, AES-256-GCM), nunca legível. Ver `security/cpf-vault.ts`. */
    cpf: text('cpf'),
    /** Dois últimos dígitos do CPF, só para a máscara. */
    cpfLast2: text('cpf_last2'),
    /** HMAC dos 4 primeiros dígitos: a chave de acesso do consignador. */
    cpfKeyHash: text('cpf_key_hash'),
    isVisitor: boolean('is_visitor').notNull().default(true),
    isBlacklisted: boolean('is_blacklisted').notNull().default(false),
    blacklistReason: text('blacklist_reason'),
    /** Quando entrou na blacklist; vazio se nunca entrou (ou se entrou antes da migration 0025). */
    blacklistedAt: timestamp('blacklisted_at', { withTimezone: true }),
    /** Quando o cliente foi anonimizado (LGPD). Anonimizado fica na blacklist e não se edita mais. */
    anonymizedAt: timestamp('anonymized_at', { withTimezone: true }),
    lastInteractionAt: timestamp('last_interaction_at', { withTimezone: true }),
    addressZip: text('address_zip'),
    addressStreet: text('address_street'),
    addressNumber: text('address_number'),
    addressComp: text('address_comp'),
    addressNeighborhood: text('address_neighborhood'),
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
    /** Quando o bot anunciou a abertura / o encerramento no grupo (evita repetir após reinício). */
    botOpenedAnnouncedAt: timestamp('bot_opened_announced_at', { withTimezone: true }),
    botClosedAnnouncedAt: timestamp('bot_closed_announced_at', { withTimezone: true }),
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
    totalAmount: money('total_amount').notNull(),
    status: settlementStatus('status').notNull().default('PENDING'),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    /** O comprador avisou que pagou. Só avisa: o estado muda quando a loja marca como pago. */
    paymentClaimedAt: timestamp('payment_claimed_at', { withTimezone: true }),
    /** Nome do comprovante (`<uuid>.<ext>`) no armazenamento; o arquivo fica em `receipts/`. */
    receiptFile: text('receipt_file'),
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

// --- Administração da plataforma (0016) ------------------------------------------
/** Log da plataforma: só o administrador grava e lê. O log da loja é só da loja. */
export const adminActivityLog = pgTable(
  'admin_activity_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index('admin_activity_log_created_idx').on(t.createdAt, t.id)],
);

/** Pedido de acesso da landing. Não cria usuário nem loja; o administrador decide. */
export const accessRequests = pgTable(
  'access_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    whatsapp: text('whatsapp'),
    storeName: text('store_name').notNull(),
    message: text('message'),
    status: accessRequestStatus('status').notNull().default('PENDING'),
    ipHash: text('ip_hash').notNull(),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    convertedStoreId: uuid('converted_store_id').references(() => stores.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
  },
  (t) => [
    index('access_requests_status_created_idx').on(t.status, t.createdAt, t.id),
    index('access_requests_ip_created_idx').on(t.ipHash, t.createdAt),
  ],
);

// --- Planos, notificações e vitrine (0017) ------------------------------------
export const planChangeRequests = pgTable(
  'plan_change_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    requestedPlan: text('requested_plan'),
    message: text('message'),
    status: planRequestStatus('status').notNull().default('PENDING'),
    requestedBy: uuid('requested_by').references(() => users.id, { onDelete: 'set null' }),
    decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('plan_change_requests_store_idx').on(t.storeId, t.createdAt),
    index('plan_change_requests_status_idx').on(t.status, t.createdAt, t.id),
  ],
);

/** Aviso interno da loja. O texto é do frontend; aqui só o código e ids. */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    unique('notifications_id_store_key').on(t.id, t.storeId),
    index('notifications_store_created_idx').on(t.storeId, t.createdAt, t.id),
  ],
);

export const notificationReads = pgTable(
  'notification_reads',
  {
    notificationId: uuid('notification_id').notNull(),
    storeId: uuid('store_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.notificationId, t.userId] }),
    foreignKey({
      name: 'notification_reads_notification_fkey',
      columns: [t.notificationId, t.storeId],
      foreignColumns: [notifications.id, notifications.storeId],
    }).onDelete('cascade'),
  ],
);

// --- Páginas públicas (0015) -------------------------------------------------
/** Link público (acerto do comprador ou acompanhamento do consignador). O token só existe em hash. */
export const publicLinks = pgTable(
  'public_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    kind: publicLinkKind('kind').notNull(),
    settlementId: uuid('settlement_id'),
    customerId: uuid('customer_id'),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('public_links_id_store_key').on(t.id, t.storeId),
    unique('public_links_token_hash_key').on(t.tokenHash),
    foreignKey({
      name: 'public_links_settlement_fkey',
      columns: [t.settlementId, t.storeId],
      foreignColumns: [settlements.id, settlements.storeId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'public_links_customer_fkey',
      columns: [t.customerId, t.storeId],
      foreignColumns: [customers.id, customers.storeId],
    }),
    index('public_links_store_kind_idx').on(t.storeId, t.kind, t.createdAt),
  ],
);

/** Consentimento LGPD de quem preenche o acerto: quem, quando, versão do texto e IP. */
export const lgpdConsents = pgTable(
  'lgpd_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    storeId: uuid('store_id')
      .notNull()
      .references(() => stores.id, { onDelete: 'cascade' }),
    customerId: uuid('customer_id').notNull(),
    settlementId: uuid('settlement_id').notNull(),
    textVersion: text('text_version').notNull(),
    ip: inet('ip'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'lgpd_consents_customer_fkey',
      columns: [t.customerId, t.storeId],
      foreignColumns: [customers.id, customers.storeId],
    }),
    foreignKey({
      name: 'lgpd_consents_settlement_fkey',
      columns: [t.settlementId, t.storeId],
      foreignColumns: [settlements.id, settlements.storeId],
    }).onDelete('cascade'),
    index('lgpd_consents_customer_idx').on(t.customerId),
  ],
);

/** Falhas de acesso público por IP (em hash). Sem nenhum grant: só as funções do banco usam. */
export const publicIpFailures = pgTable('public_ip_failures', {
  ipHash: text('ip_hash').primaryKey(),
  failures: integer('failures').notNull().default(0),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull().defaultNow(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
});

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
