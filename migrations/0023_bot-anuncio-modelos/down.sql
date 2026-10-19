-- 0023_bot-anuncio-modelos: reverte. Os modelos de mensagem e os marcadores de anúncio se perdem.
DROP POLICY bot_store_isolation ON store_message_templates;
DROP TABLE store_message_templates;

REVOKE SELECT (inactivity_days_limit) ON stores FROM bot_runtime;

ALTER TABLE cards_inventory DROP CONSTRAINT cards_inventory_short_code_upper;

REVOKE UPDATE (bot_opened_announced_at, bot_closed_announced_at) ON auctions FROM bot_runtime;
ALTER TABLE auctions DROP COLUMN bot_closed_announced_at;
ALTER TABLE auctions DROP COLUMN bot_opened_announced_at;
