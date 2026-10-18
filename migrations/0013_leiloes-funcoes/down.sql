-- 0013_leiloes-funcoes: reverte.
DROP FUNCTION advance_auctions(uuid, timestamptz);
DROP FUNCTION place_bid(uuid, uuid, uuid, numeric, text, timestamptz);
