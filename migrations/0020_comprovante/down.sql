-- 0020_comprovante: reverte.
DROP FUNCTION public_settlement_receipt_attach(text, text, text);
-- Volta a página do acerto à versão da migration 0018.
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

ALTER TABLE settlements DROP CONSTRAINT settlements_receipt_file_format;
ALTER TABLE settlements DROP COLUMN receipt_file;
