-- 0011_catalogo-busca: reverte.
DROP TABLE catalog_sync_runs;
DROP INDEX tcgdex_catalog_set_id_idx;
DROP INDEX tcgdex_catalog_search_trgm_idx;
ALTER TABLE tcgdex_catalog DROP COLUMN search_text, DROP COLUMN set_id;
