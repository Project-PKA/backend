-- 0006_leiloes: reverte.
ALTER TABLE auctions DROP CONSTRAINT auctions_winning_bid_fkey;
DROP TABLE bids;
DROP TABLE auctions;
DROP TYPE auction_status;
DROP TYPE auction_type;
