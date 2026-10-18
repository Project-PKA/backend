-- 0021_bot-runtime: reverte.
DROP FUNCTION bot_set_whatsapp_status(uuid, whatsapp_status, text);

REVOKE ALL ON FUNCTION place_bid(uuid, uuid, uuid, numeric, text, timestamptz) FROM bot_runtime;
REVOKE ALL ON FUNCTION advance_auctions(uuid, timestamptz) FROM bot_runtime;

DROP POLICY bot_store_isolation ON customers;
DROP POLICY bot_store_isolation ON cards_inventory;
DROP POLICY bot_store_isolation ON bids;
DROP POLICY bot_store_isolation ON auctions;
DROP POLICY bot_store_isolation ON whatsapp_sessions;
DROP POLICY stores_bot_select ON stores;

REVOKE ALL ON tcgdex_catalog, customers, cards_inventory, bids, auctions, whatsapp_sessions, stores
  FROM bot_runtime;
REVOKE EXECUTE ON FUNCTION app_current_store() FROM bot_runtime;
REVOKE USAGE ON SCHEMA public FROM bot_runtime;
-- O papel é do cluster inteiro e pode ter usuários de login dentro: fica (como os demais papéis).
