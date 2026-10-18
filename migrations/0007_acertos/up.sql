-- 0007_acertos: fechamento pós-leilão (ADR 0002: sem gateway, o lojista marca como pago).
CREATE TYPE settlement_status AS ENUM ('PENDING', 'PAID');

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  shipping_cost numeric(12, 2) NOT NULL DEFAULT 0,
  total_amount numeric(12, 2) NOT NULL,
  status settlement_status NOT NULL DEFAULT 'PENDING',
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlements_id_store_key UNIQUE (id, store_id),
  CONSTRAINT settlements_customer_fkey FOREIGN KEY (customer_id, store_id)
    REFERENCES customers (id, store_id),
  CONSTRAINT settlements_shipping_nonneg CHECK (shipping_cost >= 0),
  CONSTRAINT settlements_total_nonneg CHECK (total_amount >= 0),
  CONSTRAINT settlements_paid_at_matches_status CHECK ((status = 'PAID') = (paid_at IS NOT NULL))
);
CREATE INDEX settlements_store_status_idx ON settlements (store_id, status);
CREATE INDEX settlements_customer_idx ON settlements (customer_id);

-- Liga o acerto aos leilões (e cartas) que o compõem.
CREATE TABLE settlement_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL,
  auction_id uuid NOT NULL,
  card_id uuid NOT NULL,
  amount numeric(12, 2) NOT NULL,
  CONSTRAINT settlement_items_settlement_fkey FOREIGN KEY (settlement_id, store_id)
    REFERENCES settlements (id, store_id) ON DELETE CASCADE,
  CONSTRAINT settlement_items_auction_fkey FOREIGN KEY (auction_id, store_id)
    REFERENCES auctions (id, store_id),
  CONSTRAINT settlement_items_card_fkey FOREIGN KEY (card_id, store_id)
    REFERENCES cards_inventory (id, store_id),
  CONSTRAINT settlement_items_amount_positive CHECK (amount > 0),
  -- Um leilão entra em no máximo um acerto.
  CONSTRAINT settlement_items_auction_key UNIQUE (auction_id)
);
CREATE INDEX settlement_items_settlement_idx ON settlement_items (settlement_id);
