-- 0012_estoque-observacoes: campo "Observações" do cadastro de carta (adendo do design).
ALTER TABLE cards_inventory
  ADD COLUMN notes text,
  ADD CONSTRAINT cards_inventory_notes_length CHECK (notes IS NULL OR char_length(notes) <= 2000);
