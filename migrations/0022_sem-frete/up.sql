-- 0022_sem-frete: o sistema não trata de frete nem de envio (decisão do dono, shared#8 e #5).
-- A loja combina o envio por fora; o bot só fala no grupo. Some a fila de envios e o frete do acerto.

-- Envio era histórico, mas o produto deixou de ter essa tela: sai a tabela inteira (e as políticas de RLS).
DROP TABLE shipments;
DROP TYPE shipment_status;

-- O total do acerto passa a ser só o valor dos itens. A tabela tem FORCE RLS e a política vale só para
-- `app_runtime`, então o ajuste solta o FORCE por um instante (o dono da tabela executa a migration).
ALTER TABLE settlements NO FORCE ROW LEVEL SECURITY;
UPDATE settlements s
   SET total_amount = coalesce((SELECT sum(si.amount) FROM settlement_items si
                                 WHERE si.settlement_id = s.id AND si.store_id = s.store_id), 0)
 WHERE s.shipping_cost <> 0;
ALTER TABLE settlements FORCE ROW LEVEL SECURITY;

ALTER TABLE settlements DROP COLUMN shipping_cost;

-- A página pública do acerto deixa de mostrar o frete (versão da 0020, sem `shipping_cost`).
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
