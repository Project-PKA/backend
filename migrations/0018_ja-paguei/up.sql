-- 0018_ja-paguei: o comprador avisa que pagou. Só AVISA a loja: nunca muda o estado do acerto
-- (quem marca como pago é a loja, ADR 0002 e 0013). O comprovante em arquivo depende da D3.
ALTER TABLE settlements ADD COLUMN payment_claimed_at timestamptz;

-- A página pública do acerto passa a mostrar se o aviso já foi dado.
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

-- "Já paguei": grava o aviso uma vez e notifica a loja. NULL = link inválido (igual a todo motivo).
-- Resposta: {"result": "OK"} (aviso registrado, agora ou antes) ou {"result": "ALREADY_PAID"}.
CREATE FUNCTION public_settlement_claim_paid(p_token text, p_ip text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v public.public_links%ROWTYPE;
  v_status public.settlement_status;
  v_claimed timestamptz;
BEGIN
  v := public.public_resolve_link(p_token, 'SETTLEMENT', p_ip);
  IF v.id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT s.status, s.payment_claimed_at INTO v_status, v_claimed
    FROM public.settlements s
   WHERE s.id = v.settlement_id AND s.store_id = v.store_id
     FOR UPDATE;
  IF v_status = 'PAID' THEN
    RETURN jsonb_build_object('result', 'ALREADY_PAID');
  END IF;
  IF v_claimed IS NULL THEN
    UPDATE public.settlements s SET payment_claimed_at = now()
     WHERE s.id = v.settlement_id AND s.store_id = v.store_id;
    INSERT INTO public.notifications (store_id, kind, data)
    VALUES (v.store_id, 'PAYMENT_CLAIMED', jsonb_build_object('settlement_id', v.settlement_id));
  END IF;
  RETURN jsonb_build_object('result', 'OK');
END;
$$;
REVOKE ALL ON FUNCTION public_settlement_claim_paid(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_settlement_claim_paid(text, text) TO public_runtime;
