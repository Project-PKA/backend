-- 0005_estoque: cada linha é UMA carta física única (ADR 0003).
CREATE TYPE card_condition AS ENUM ('MINT', 'NM', 'SP', 'MP', 'HP', 'DMG');
CREATE TYPE ownership_type AS ENUM ('OWN', 'CONSIGNED');
CREATE TYPE card_status AS ENUM ('AVAILABLE', 'SCHEDULED', 'AWAITING_CONFIRMATION', 'SOLD');

CREATE TABLE cards_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  -- ID curto SEM o '#': o '#' é só o prefixo da mensagem no grupo.
  short_code text NOT NULL,
  tcgdex_id text NOT NULL REFERENCES tcgdex_catalog (id),
  language text NOT NULL,
  condition card_condition NOT NULL,
  is_foil boolean NOT NULL DEFAULT false,
  custom_photos jsonb NOT NULL DEFAULT '[]'::jsonb,
  ownership_type ownership_type NOT NULL,
  consignor_id uuid,
  store_commission_pct numeric(5, 2),
  status card_status NOT NULL DEFAULT 'AVAILABLE',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cards_inventory_store_short_code_key UNIQUE (store_id, short_code),
  CONSTRAINT cards_inventory_id_store_key UNIQUE (id, store_id),
  -- O consignador precisa ser da mesma loja da carta.
  CONSTRAINT cards_inventory_consignor_fkey FOREIGN KEY (consignor_id, store_id)
    REFERENCES customers (id, store_id),
  CONSTRAINT cards_inventory_short_code_format CHECK (short_code ~ '^[A-Za-z0-9]{1,12}$'),
  CONSTRAINT cards_inventory_language_format CHECK (language ~ '^[A-Z]{2}$'),
  CONSTRAINT cards_inventory_photos_is_array CHECK (jsonb_typeof(custom_photos) = 'array'),
  CONSTRAINT cards_inventory_commission_range
    CHECK (store_commission_pct IS NULL OR store_commission_pct BETWEEN 0 AND 100),
  -- Consignada exige dono e comissão; estoque próprio não tem nenhum dos dois.
  CONSTRAINT cards_inventory_ownership_consistent CHECK (
    (ownership_type = 'OWN' AND consignor_id IS NULL AND store_commission_pct IS NULL)
    OR (ownership_type = 'CONSIGNED' AND consignor_id IS NOT NULL AND store_commission_pct IS NOT NULL)
  )
);
CREATE INDEX cards_inventory_store_status_idx ON cards_inventory (store_id, status);
CREATE INDEX cards_inventory_tcgdex_id_idx ON cards_inventory (tcgdex_id);
CREATE INDEX cards_inventory_consignor_idx ON cards_inventory (consignor_id)
  WHERE consignor_id IS NOT NULL;
