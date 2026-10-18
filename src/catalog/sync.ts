import { count, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/context.js';
import * as schema from '../db/schema.js';
import { buildSearchText } from './normalize.js';
import type { CardBrief, SetBrief, TcgdexClient } from './tcgdex.js';

const { tcgdexCatalog, catalogSyncRuns } = schema;

export interface SyncSummary {
  seen: number;
  inserted: number;
  updated: number;
  skipped: number;
}

export interface SyncOptions {
  db: Db;
  client: TcgdexClient;
  /** O primeiro é o idioma canônico (nome e coleção gravados nas colunas). Ex.: `['en', 'pt']`. */
  languages: string[];
  log?: {
    info: (o: Record<string, unknown>, m: string) => void;
    warn: (o: Record<string, unknown>, m: string) => void;
  };
  /** A resposta que traz menos que esta fração do catálogo atual é tratada como suspeita. */
  minRatio?: number;
}

interface Entry {
  id: string;
  localId: string;
  setId: string | null;
  names: Record<string, string>;
  setNames: Record<string, string>;
  images: Record<string, string>;
}

const BATCH = 2000;

/** Coleção de uma carta: o maior id de coleção que é prefixo do id da carta (`id = coleção-número`). */
function setIdOf(cardId: string, setIds: readonly string[]): string | null {
  let best: string | null = null;
  for (const setId of setIds) {
    if (cardId.startsWith(`${setId}-`) && (best === null || setId.length > best.length))
      best = setId;
  }
  return best ?? (cardId.includes('-') ? (cardId.split('-')[0] ?? null) : null);
}

function mergeLanguage(
  entries: Map<string, Entry>,
  language: string,
  cards: CardBrief[],
  sets: SetBrief[],
): void {
  const setNameById = new Map(sets.map((set) => [set.id, set.name]));
  const setIds = sets.map((set) => set.id);
  for (const card of cards) {
    const entry = entries.get(card.id) ?? {
      id: card.id,
      localId: card.localId,
      setId: setIdOf(card.id, setIds),
      names: {},
      setNames: {},
      images: {},
    };
    entry.names[language] = card.name;
    const setName = entry.setId === null ? undefined : setNameById.get(entry.setId);
    if (setName !== undefined) entry.setNames[language] = setName;
    if (card.image !== null) entry.images[language] = card.image;
    entries.set(card.id, entry);
  }
}

const first = (record: Record<string, string>, order: readonly string[]): string | undefined =>
  order.map((language) => record[language]).find((value) => value !== undefined) ??
  Object.values(record)[0];

/**
 * Sincroniza o catálogo local com o TCGdex (ADR 0009). Idempotente: só grava o que mudou, nunca
 * apaga (cartas do estoque apontam para o catálogo) e preserva o que foi enriquecido depois
 * (a raridade, buscada sob demanda). Falha inteira, sem gravar nada, se a resposta parecer parcial.
 */
export async function syncCatalog(options: SyncOptions): Promise<SyncSummary> {
  const { db, client, languages, log } = options;
  const minRatio = options.minRatio ?? 0.5;
  const [run] = await db
    .insert(catalogSyncRuns)
    .values({ source: 'tcgdex', languages })
    .returning({ id: catalogSyncRuns.id });
  if (run === undefined) throw new Error('não foi possível registrar a execução do sync');

  try {
    const entries = new Map<string, Entry>();
    let skipped = 0;
    for (const language of languages) {
      const [{ sets, skipped: skippedSets }, { cards, skipped: skippedCards }] = await Promise.all([
        client.listSets(language),
        client.listCards(language),
      ]);
      skipped += skippedSets + skippedCards;
      mergeLanguage(entries, language, cards, sets);
      log?.info({ language, cards: cards.length, sets: sets.length }, 'catálogo: idioma lido');
    }

    const [current] = await db.select({ total: count() }).from(tcgdexCatalog);
    const known = current?.total ?? 0;
    if (known > 1000 && entries.size < known * minRatio) {
      throw new Error(`resposta suspeita: ${entries.size} cartas contra ${known} no catálogo`);
    }

    const rows = [...entries.values()];
    let inserted = 0;
    let updated = 0;
    for (let start = 0; start < rows.length; start += BATCH) {
      const batch = rows.slice(start, start + BATCH);
      const prepared = batch.map((entry) => {
        const name = first(entry.names, languages) ?? entry.id;
        const setName = first(entry.setNames, languages) ?? entry.setId ?? '';
        return {
          id: entry.id,
          name,
          number: entry.localId,
          setName,
          setId: entry.setId,
          search: buildSearchText({
            names: Object.values(entry.names),
            localId: entry.localId,
            setNames: Object.values(entry.setNames),
            setId: entry.setId,
          }),
          raw: { names: entry.names, set_names: entry.setNames, images: entry.images },
        };
      });
      const payload = prepared.map((r) => ({
        id: r.id,
        name: r.name,
        card_number: r.number,
        set_name: r.setName,
        set_id: r.setId,
        search_text: r.search,
        raw_data: r.raw,
      }));
      const result = await db.execute<{ inserted: boolean }>(sql`
        INSERT INTO tcgdex_catalog AS t (id, name, card_number, set_name, set_id, search_text, raw_data)
        SELECT id, name, card_number, set_name, set_id, search_text, raw_data
          FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS u(
            id text, name text, card_number text, set_name text, set_id text,
            search_text text, raw_data jsonb
          )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          card_number = EXCLUDED.card_number,
          set_name = EXCLUDED.set_name,
          set_id = EXCLUDED.set_id,
          search_text = EXCLUDED.search_text,
          -- Mantém o que já foi enriquecido (raridade) e atualiza o resto.
          raw_data = t.raw_data || EXCLUDED.raw_data,
          updated_at = now()
        WHERE (t.name, t.card_number, t.set_name, t.set_id, t.search_text, t.raw_data)
          IS DISTINCT FROM
          (EXCLUDED.name, EXCLUDED.card_number, EXCLUDED.set_name, EXCLUDED.set_id,
           EXCLUDED.search_text, t.raw_data || EXCLUDED.raw_data)
        RETURNING (xmax = 0) AS inserted
      `);
      for (const row of result.rows) {
        if (row.inserted) inserted += 1;
        else updated += 1;
      }
    }

    const summary: SyncSummary = { seen: rows.length, inserted, updated, skipped };
    await db
      .update(catalogSyncRuns)
      .set({
        status: 'OK',
        finishedAt: new Date(),
        cardsSeen: summary.seen,
        cardsInserted: inserted,
        cardsUpdated: updated,
        cardsSkipped: skipped,
      })
      .where(eq(catalogSyncRuns.id, run.id));
    log?.info({ ...summary }, 'catálogo: sync concluído');
    return summary;
  } catch (err) {
    const message = (err instanceof Error ? err.message : 'erro desconhecido').slice(0, 480);
    await db
      .update(catalogSyncRuns)
      .set({ status: 'FAILED', finishedAt: new Date(), error: message })
      .where(eq(catalogSyncRuns.id, run.id));
    log?.warn({ error: message }, 'catálogo: sync falhou');
    throw err;
  }
}
