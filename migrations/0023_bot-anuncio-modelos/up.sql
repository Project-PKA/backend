-- 0023_bot-anuncio-modelos: pedidos do bot ao Backend (shared#32 e #33, aprovados em OWNER.md D21).

-- 1) Marcador de anúncio: o bot lembra no banco o que já anunciou no grupo, para não repetir depois de
--    um reinício. Só estas duas colunas ganham UPDATE para o `bot_runtime`.
ALTER TABLE auctions ADD COLUMN bot_opened_announced_at timestamptz;
ALTER TABLE auctions ADD COLUMN bot_closed_announced_at timestamptz;
GRANT UPDATE (bot_opened_announced_at, bot_closed_announced_at) ON auctions TO bot_runtime;

-- 2) `short_code` sem diferenciar caixa: o lance `#a41` é lido sem diferenciar caixa, então `A41` e `a41`
--    não podem ser cartas diferentes. A API já grava em maiúsculas; o banco passa a exigir.
--    A tabela tem FORCE RLS e a política vale só para `app_runtime`: solta o FORCE por um instante.
ALTER TABLE cards_inventory NO FORCE ROW LEVEL SECURITY;
UPDATE cards_inventory SET short_code = upper(short_code) WHERE short_code <> upper(short_code);
ALTER TABLE cards_inventory FORCE ROW LEVEL SECURITY;
ALTER TABLE cards_inventory ADD CONSTRAINT cards_inventory_short_code_upper
  CHECK (short_code = upper(short_code));

-- 3) Inatividade: o bot remove do grupo quem passou do limite da loja, então precisa ler essa coluna.
GRANT SELECT (inactivity_days_limit) ON stores TO bot_runtime;

-- 4) Modelos de mensagem por loja (ADR 0006: "textos configuráveis"). Sem linha = o bot usa o padrão.
--    As chaves são as que o bot conhece (`templates.py`); marcadores `{nome}` são conferidos pela API.
CREATE TABLE store_message_templates (
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  key text NOT NULL,
  body text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, key),
  CONSTRAINT store_message_templates_key_known CHECK (key IN (
    'card_opened', 'bid_too_low', 'invalid_amount', 'not_started', 'ended', 'not_active',
    'ceiling_reached', 'auction_won', 'auction_unsold')),
  CONSTRAINT store_message_templates_body_size CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON store_message_templates TO app_runtime;
ALTER TABLE store_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_message_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON store_message_templates TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- O bot só lê, e só a loja do contexto.
GRANT SELECT ON store_message_templates TO bot_runtime;
CREATE POLICY bot_store_isolation ON store_message_templates TO bot_runtime
  USING (store_id = app_current_store());
