-- 0006_leiloes: leilões e lances (ADR 0003 e 0004).
CREATE TYPE auction_type AS ENUM ('FREE_BID', 'POLL');
CREATE TYPE auction_status AS ENUM
  ('PENDING', 'ACTIVE', 'PAUSED_FOR_VALIDATION', 'FINISHED', 'CANCELLED');

CREATE TABLE auctions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  card_id uuid NOT NULL,
  type auction_type NOT NULL,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  initial_bid numeric(12, 2) NOT NULL,
  min_increment numeric(12, 2) NOT NULL,
  max_poll_value numeric(12, 2),
  max_value_reached_alert boolean NOT NULL DEFAULT false,
  winning_bid_id uuid,
  status auction_status NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auctions_id_store_key UNIQUE (id, store_id),
  CONSTRAINT auctions_card_fkey FOREIGN KEY (card_id, store_id)
    REFERENCES cards_inventory (id, store_id),
  CONSTRAINT auctions_period_valid CHECK (end_time > start_time),
  CONSTRAINT auctions_initial_bid_positive CHECK (initial_bid > 0),
  CONSTRAINT auctions_min_increment_positive CHECK (min_increment > 0),
  -- Enquete exige teto acima do lance inicial; lance livre não tem teto.
  CONSTRAINT auctions_poll_ceiling CHECK (
    (type = 'POLL' AND max_poll_value IS NOT NULL AND max_poll_value > initial_bid)
    OR (type = 'FREE_BID' AND max_poll_value IS NULL)
  ),
  CONSTRAINT auctions_alert_only_for_poll CHECK (type = 'POLL' OR NOT max_value_reached_alert)
);
-- Uma carta só pode estar em um leilão em andamento por vez.
CREATE UNIQUE INDEX auctions_one_open_per_card_idx ON auctions (card_id)
  WHERE status IN ('PENDING', 'ACTIVE', 'PAUSED_FOR_VALIDATION');
CREATE INDEX auctions_store_status_start_idx ON auctions (store_id, status, start_time);
-- Para o agendador abrir e fechar leilões no horário.
CREATE INDEX auctions_status_start_idx ON auctions (status, start_time);
CREATE INDEX auctions_status_end_idx ON auctions (status, end_time);

CREATE TABLE bids (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  auction_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  amount numeric(12, 2) NOT NULL,
  -- Mensagem original do grupo. Pode conter dado pessoal: tratar na revisão de LGPD.
  raw_whatsapp_message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bids_id_store_key UNIQUE (id, store_id),
  CONSTRAINT bids_auction_fkey FOREIGN KEY (auction_id, store_id)
    REFERENCES auctions (id, store_id),
  CONSTRAINT bids_customer_fkey FOREIGN KEY (customer_id, store_id)
    REFERENCES customers (id, store_id),
  CONSTRAINT bids_amount_positive CHECK (amount > 0),
  -- Dois lances do mesmo valor no mesmo leilão não coexistem: o primeiro vence o empate.
  CONSTRAINT bids_auction_amount_key UNIQUE (auction_id, amount)
);
CREATE INDEX bids_customer_created_idx ON bids (customer_id, created_at);
CREATE INDEX bids_store_created_idx ON bids (store_id, created_at);

ALTER TABLE auctions ADD CONSTRAINT auctions_winning_bid_fkey
  FOREIGN KEY (winning_bid_id, store_id) REFERENCES bids (id, store_id);
