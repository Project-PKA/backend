import { sql } from 'drizzle-orm';

import type { Db, Tx } from '../db/context.js';

export interface SettlementPage {
  store_name: string;
  pix_key: string | null;
  status: 'PENDING' | 'PAID';
  payment_claimed_at: string | null;
  receipt_sent: boolean;
  total_amount: string;
  expires_at: string;
  items: {
    short_code: string;
    name: string;
    condition: string;
    language: string;
    amount: string;
  }[];
  buyer: {
    first_name: string;
    cpf_masked: string | null;
    city: string | null;
    state: string | null;
    has_address: boolean;
  };
}

export interface BuyerData {
  cpf: string;
  zip: string;
  street: string;
  number: string;
  comp: string | null;
  city: string;
  state: string;
  consentVersion: string;
}

export type SubmitOutcome = 'OK' | 'CONSENT_REQUIRED' | 'INVALID_DATA';

export interface ShowcasePage {
  items: Record<string, unknown>[];
  total: number;
  stores: { id: string; name: string }[];
}

export interface ConsignorPage {
  store_name: string;
  first_name: string;
  expires_at: string;
  estimate_is_final: boolean;
  cards: Record<string, unknown>[];
}

/**
 * Acesso público (ADR 0014). Cada chamada roda numa transação com `SET LOCAL ROLE public_runtime`:
 * o papel não lê tabela nenhuma e só executa as funções `public_*`, que recebem o token e devolvem
 * os campos permitidos. `null` quer dizer "link inválido" e é igual para todo motivo.
 */
export class PublicAccessService {
  constructor(private readonly db: Db) {}

  private async asPublic<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE public_runtime`);
      return work(tx);
    });
  }

  async settlement(token: string, ip: string): Promise<SettlementPage | null> {
    return this.asPublic(async (tx) => {
      const result = await tx.execute<{ page: SettlementPage | null }>(
        sql`SELECT public_settlement_view(${token}::text, ${ip}::text) AS page`,
      );
      return result.rows[0]?.page ?? null;
    });
  }

  async submitBuyerData(token: string, ip: string, data: BuyerData): Promise<SubmitOutcome | null> {
    return this.asPublic(async (tx) => {
      const result = await tx.execute<{ outcome: { result: SubmitOutcome } | null }>(sql`
        SELECT public_settlement_submit(${token}::text, ${ip}::text, ${data.cpf}::text, ${data.zip}::text,
          ${data.street}::text, ${data.number}::text, ${data.comp}::text, ${data.city}::text,
          ${data.state}::text, true, ${data.consentVersion}::text) AS outcome
      `);
      return result.rows[0]?.outcome?.result ?? null;
    });
  }

  /** Leilões ao vivo das lojas que optaram pela vitrine. Página e deslocamento têm teto no banco. */
  async showcase(filters: {
    store: string | null;
    language: string | null;
    sort: string | null;
    limit: number;
    offset: number;
  }): Promise<ShowcasePage> {
    return this.asPublic(async (tx) => {
      const result = await tx.execute<{ page: ShowcasePage }>(sql`
        SELECT public_showcase_list(${filters.store}::uuid, ${filters.language}::text,
          ${filters.sort}::text, ${filters.limit}::integer, ${filters.offset}::integer) AS page
      `);
      return result.rows[0]?.page ?? { items: [], total: 0, stores: [] };
    });
  }

  /** Grava o pedido de acesso. Nunca informa se era novo, repetido ou descartado por abuso. */
  async submitAccessRequest(
    ip: string,
    data: {
      name: string;
      email: string;
      whatsapp: string | null;
      storeName: string;
      message: string | null;
    },
  ): Promise<void> {
    await this.asPublic(async (tx) => {
      await tx.execute(sql`
        SELECT public_access_request_submit(${data.name}::text, ${data.email}::text,
          ${data.whatsapp}::text, ${data.storeName}::text, ${data.message}::text, ${ip}::text)
      `);
    });
  }

  /** O comprador avisa que pagou. Só grava o aviso e notifica a loja; nunca marca como pago. */
  async claimPaid(token: string, ip: string): Promise<'OK' | 'ALREADY_PAID' | null> {
    return this.asPublic(async (tx) => {
      const result = await tx.execute<{ outcome: { result: 'OK' | 'ALREADY_PAID' } | null }>(
        sql`SELECT public_settlement_claim_paid(${token}::text, ${ip}::text) AS outcome`,
      );
      return result.rows[0]?.outcome?.result ?? null;
    });
  }

  async consignor(token: string, key: string, ip: string): Promise<ConsignorPage | null> {
    return this.asPublic(async (tx) => {
      const result = await tx.execute<{ page: ConsignorPage | null }>(
        sql`SELECT public_consignor_view(${token}::text, ${key}::text, ${ip}::text) AS page`,
      );
      return result.rows[0]?.page ?? null;
    });
  }
}
