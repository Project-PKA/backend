import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { escapeLike, queryTokens } from './normalize.js';
import { isValidCardId, type TcgdexClient } from './tcgdex.js';

const { tcgdexCatalog } = schema;

export interface CatalogCard {
  id: string;
  name: string;
  names: Record<string, string>;
  number: string;
  setId: string | null;
  setName: string;
  /** Miniatura e imagem grande. Apontam para a origem: as imagens não são copiadas. */
  imageUrl: string | null;
  imageHighUrl: string | null;
  rarity: string | null;
}

interface RawData {
  names?: Record<string, string>;
  images?: Record<string, string>;
  rarity?: string;
}

export function toCatalogCard(row: typeof tcgdexCatalog.$inferSelect): CatalogCard {
  const raw = row.rawData as RawData;
  const base = raw.images?.['en'] ?? Object.values(raw.images ?? {})[0] ?? null;
  return {
    id: row.id,
    name: row.name,
    names: raw.names ?? {},
    number: row.cardNumber,
    setId: row.setId,
    setName: row.setName,
    imageUrl: base === null ? null : `${base}/low.webp`,
    imageHighUrl: base === null ? null : `${base}/high.webp`,
    rarity: raw.rarity ?? null,
  };
}

export class CatalogService {
  constructor(
    private readonly db: Db,
    private readonly client: TcgdexClient,
    private readonly log?: { warn: (o: Record<string, unknown>, m: string) => void },
  ) {}

  /**
   * Busca as-you-type: todos os termos precisam aparecer (sem acento, sem maiúsculas) no nome,
   * número ou coleção. Quem começa pelo termo vem primeiro, depois os nomes mais curtos.
   */
  async search(query: string, limit: number): Promise<CatalogCard[]> {
    const tokens = queryTokens(query);
    if (tokens.length === 0) return [];
    const first = tokens[0] ?? '';
    const patterns = tokens.map((token) => '%' + escapeLike(token) + '%');
    const rows = await this.db
      .select()
      .from(tcgdexCatalog)
      .where(
        and(
          ...patterns.map(
            (pattern) => sql`${tcgdexCatalog.searchText} ILIKE ${pattern} ESCAPE '\\'`,
          ),
        ),
      )
      .orderBy(
        sql`strpos(${tcgdexCatalog.searchText}, ${first})`,
        sql`char_length(${tcgdexCatalog.name})`,
        tcgdexCatalog.id,
      )
      .limit(limit);
    return rows.map(toCatalogCard);
  }

  /**
   * Uma carta do catálogo. A raridade só vem na carta completa do TCGdex, então é buscada na
   * primeira vez e guardada. Se o TCGdex estiver fora do ar, a carta volta sem raridade: o
   * catálogo local nunca fica refém da API.
   */
  async getCard(id: string): Promise<CatalogCard | null> {
    if (!isValidCardId(id)) return null;
    const [row] = await this.db
      .select()
      .from(tcgdexCatalog)
      .where(eq(tcgdexCatalog.id, id))
      .limit(1);
    if (row === undefined) return null;
    if ((row.rawData as RawData).rarity !== undefined) return toCatalogCard(row);

    try {
      const detail = await this.client.getCard('en', id);
      if (detail?.rarity != null) {
        const [updated] = await this.db
          .update(tcgdexCatalog)
          .set({
            rawData: sql`${tcgdexCatalog.rawData} || ${JSON.stringify({ rarity: detail.rarity })}::jsonb`,
          })
          .where(eq(tcgdexCatalog.id, id))
          .returning();
        return toCatalogCard(updated ?? row);
      }
    } catch (err) {
      this.log?.warn(
        { error: err instanceof Error ? err.message : 'erro' },
        'catálogo: raridade indisponível',
      );
    }
    return toCatalogCard(row);
  }
}
