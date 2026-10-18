-- 0012_estoque-observacoes: reverte.
ALTER TABLE cards_inventory DROP CONSTRAINT cards_inventory_notes_length, DROP COLUMN notes;
