-- 0003_catalogo-tcgdex: catálogo global (sem store_id), exceção consciente (ADR 0009).
CREATE TABLE tcgdex_catalog (
  id text PRIMARY KEY,
  name text NOT NULL,
  card_number text NOT NULL,
  set_name text NOT NULL,
  raw_data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Autocomplete as-you-type (ILIKE '%termo%') via pg_trgm.
CREATE INDEX tcgdex_catalog_name_trgm_idx ON tcgdex_catalog USING gin (name gin_trgm_ops);
CREATE INDEX tcgdex_catalog_card_number_trgm_idx
  ON tcgdex_catalog USING gin (card_number gin_trgm_ops);
