-- 0001_extensoes: extensões usadas pelo catálogo TCGdex (ADR 0009).
-- pg_trgm habilita o índice GIN com gin_trgm_ops para o autocomplete.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
