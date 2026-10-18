-- 0011_catalogo-busca: busca as-you-type no catálogo (ADR 0009) e registro do sync noturno.
--
-- search_text: nomes (em todos os idiomas sincronizados), número, coleção e id da coleção,
-- em minúsculas e sem acento, para o ILIKE achar "flabebe" em "Flabébé". É calculado pela
-- aplicação (src/catalog/normalize.ts), no sync e na busca, com a mesma função.
ALTER TABLE tcgdex_catalog
  ADD COLUMN set_id text,
  ADD COLUMN search_text text NOT NULL DEFAULT '';

CREATE INDEX tcgdex_catalog_search_trgm_idx ON tcgdex_catalog USING gin (search_text gin_trgm_ops);
CREATE INDEX tcgdex_catalog_set_id_idx ON tcgdex_catalog (set_id);

-- Uma linha por execução do sync: mostra se o catálogo está em dia e por que falhou.
-- Global (como o catálogo), sem dado de loja nem de pessoa. `error` guarda só a mensagem curta.
CREATE TABLE catalog_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  languages text[] NOT NULL,
  status text NOT NULL DEFAULT 'RUNNING',
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  cards_seen integer,
  cards_inserted integer,
  cards_updated integer,
  cards_skipped integer,
  error text,
  CONSTRAINT catalog_sync_runs_status_valid CHECK (status IN ('RUNNING', 'OK', 'FAILED')),
  CONSTRAINT catalog_sync_runs_finished_matches_status
    CHECK ((status = 'RUNNING') = (finished_at IS NULL)),
  CONSTRAINT catalog_sync_runs_error_short CHECK (error IS NULL OR char_length(error) <= 500)
);
CREATE INDEX catalog_sync_runs_started_idx ON catalog_sync_runs (started_at DESC);

GRANT SELECT, INSERT, UPDATE ON catalog_sync_runs TO app_runtime;
