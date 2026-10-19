-- 0022_sem-frete: reverte. O frete volta zerado e a fila de envios volta vazia (os dados não se recuperam).
ALTER TABLE settlements ADD COLUMN shipping_cost numeric(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE settlements ADD CONSTRAINT settlements_shipping_nonneg CHECK (shipping_cost >= 0);

CREATE TYPE shipment_status AS ENUM ('TO_SHIP', 'SHIPPED', 'DELIVERED');

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  settlement_id uuid NOT NULL,
  status shipment_status NOT NULL DEFAULT 'TO_SHIP',
  tracking_code text,
  shipped_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shipments_id_store_key UNIQUE (id, store_id),
  CONSTRAINT shipments_settlement_key UNIQUE (settlement_id),
  CONSTRAINT shipments_settlement_fkey FOREIGN KEY (settlement_id, store_id)
    REFERENCES settlements (id, store_id),
  CONSTRAINT shipments_tracking_format
    CHECK (tracking_code IS NULL OR tracking_code ~ '^[A-Za-z0-9._/-]{4,60}$'),
  CONSTRAINT shipments_dates_match_status CHECK (
    (status = 'TO_SHIP' AND shipped_at IS NULL AND delivered_at IS NULL)
    OR (status = 'SHIPPED' AND shipped_at IS NOT NULL AND delivered_at IS NULL)
    OR (status = 'DELIVERED' AND shipped_at IS NOT NULL AND delivered_at IS NOT NULL)
  )
);
CREATE INDEX shipments_store_status_idx ON shipments (store_id, status);

GRANT SELECT, INSERT, UPDATE ON shipments TO app_runtime;
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shipments FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON shipments TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- Volta a página do acerto à versão da migration 0020 (com `shipping_cost`).
CREATE OR REPLACE FUNCTION public_settlement_view(p_token text, p_ip text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v public.public_links%ROWTYPE;
BEGIN
  v := public.public_resolve_link(p_token, 'SETTLEMENT', p_ip);
  IF v.id IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (
    SELECT jsonb_build_object(
      'store_name', st.name,
      'pix_key', CASE WHEN s.status = 'PENDING' THEN st.pix_key END,
      'status', s.status,
      'payment_claimed_at', s.payment_claimed_at,
      'receipt_sent', (s.receipt_file IS NOT NULL),
      -- Dinheiro sai como texto com 2 casas, como no resto da API (jsonb perderia o zero final).
      'shipping_cost', s.shipping_cost::numeric(12, 2)::text,
      'total_amount', s.total_amount::numeric(12, 2)::text,
      'expires_at', v.expires_at,
      'items', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
                 'short_code', c.short_code, 'name', t.name, 'condition', c.condition,
                 'language', c.language, 'amount', si.amount::numeric(12, 2)::text)
                 ORDER BY c.short_code)
          FROM public.settlement_items si
          JOIN public.cards_inventory c ON c.id = si.card_id AND c.store_id = si.store_id
          JOIN public.tcgdex_catalog t ON t.id = c.tcgdex_id
         WHERE si.settlement_id = s.id AND si.store_id = s.store_id), '[]'::jsonb),
      'buyer', jsonb_build_object(
        'first_name', split_part(cu.name, ' ', 1),
        'cpf_masked', CASE WHEN cu.cpf IS NULL THEN NULL
                           ELSE '•••.•••.•••-' || right(cu.cpf, 2) END,
        'city', cu.address_city,
        'state', cu.address_state,
        'has_address', (cu.address_zip IS NOT NULL AND cu.address_street IS NOT NULL
                        AND cu.address_number IS NOT NULL AND cu.address_city IS NOT NULL
                        AND cu.address_state IS NOT NULL))
    )
      FROM public.settlements s
      JOIN public.stores st ON st.id = s.store_id
      JOIN public.customers cu ON cu.id = s.customer_id AND cu.store_id = s.store_id
     WHERE s.id = v.settlement_id AND s.store_id = v.store_id
  );
END;
$$;
