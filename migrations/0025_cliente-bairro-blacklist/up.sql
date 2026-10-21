-- 0025_cliente-bairro-blacklist: bairro no endereço do cliente e a data em que entrou na blacklist
-- (Backend#108). Só colunas novas e nulas: nada é reescrito. Cliente que já estava na blacklist fica
-- com `blacklisted_at` vazio (não há de onde tirar a data); a tela mostra "sem data".
ALTER TABLE customers
  ADD COLUMN address_neighborhood text,
  ADD COLUMN blacklisted_at timestamptz;

ALTER TABLE customers
  ADD CONSTRAINT customers_blacklisted_at_requires_flag
    CHECK (blacklisted_at IS NULL OR is_blacklisted);
