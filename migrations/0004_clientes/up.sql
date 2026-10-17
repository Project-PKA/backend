-- 0004_clientes: clientes, consignadores e visitantes numa tabela só (ADR 0005).
CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  phone text NOT NULL,
  name text NOT NULL,
  email text,
  cpf text,
  is_visitor boolean NOT NULL DEFAULT true,
  is_blacklisted boolean NOT NULL DEFAULT false,
  blacklist_reason text,
  last_interaction_at timestamptz,
  address_zip text,
  address_street text,
  address_number text,
  address_comp text,
  address_city text,
  address_state text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customers_store_phone_key UNIQUE (store_id, phone),
  -- Permite que outras tabelas garantam, por FK composta, que o cliente é da mesma loja.
  CONSTRAINT customers_id_store_key UNIQUE (id, store_id),
  CONSTRAINT customers_address_state_uf CHECK (address_state IS NULL OR address_state ~ '^[A-Z]{2}$'),
  CONSTRAINT customers_blacklist_reason_requires_flag
    CHECK (blacklist_reason IS NULL OR is_blacklisted)
);
CREATE INDEX customers_store_blacklisted_idx ON customers (store_id) WHERE is_blacklisted;
CREATE INDEX customers_store_last_interaction_idx ON customers (store_id, last_interaction_at);
