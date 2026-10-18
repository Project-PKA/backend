-- 0020_comprovante: o comprador anexa o comprovante de pagamento (imagem) pelo link do acerto.
-- Só anexa: nunca muda o estado do acerto (quem marca como pago é a loja, ADR 0002 e 0013).
-- O arquivo fica no armazenamento (D3, disco da VPS); aqui só o nome gerado pelo servidor.
ALTER TABLE settlements ADD COLUMN receipt_file text;
ALTER TABLE settlements ADD CONSTRAINT settlements_receipt_file_format
  CHECK (receipt_file IS NULL
         OR receipt_file ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$');

-- A página pública do acerto passa a mostrar se o comprovante já foi enviado.
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

-- Anexa o comprovante (um por acerto). O API grava o arquivo ANTES e apaga se a resposta não for OK.
-- NULL = link inválido (igual a todo motivo). Resposta: {"result": "OK" | "ALREADY_PAID" | "RECEIPT_EXISTS"}.
-- Anexar também vale como "já paguei": registra o aviso (uma vez) e notifica a loja.
CREATE FUNCTION public_settlement_receipt_attach(p_token text, p_ip text, p_file text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v public.public_links%ROWTYPE;
  v_status public.settlement_status;
  v_claimed timestamptz;
  v_receipt text;
BEGIN
  v := public.public_resolve_link(p_token, 'SETTLEMENT', p_ip);
  IF v.id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT s.status, s.payment_claimed_at, s.receipt_file INTO v_status, v_claimed, v_receipt
    FROM public.settlements s
   WHERE s.id = v.settlement_id AND s.store_id = v.store_id
     FOR UPDATE;
  IF v_status = 'PAID' THEN
    RETURN jsonb_build_object('result', 'ALREADY_PAID');
  END IF;
  IF v_receipt IS NOT NULL THEN
    RETURN jsonb_build_object('result', 'RECEIPT_EXISTS');
  END IF;
  UPDATE public.settlements s
     SET receipt_file = p_file,
         payment_claimed_at = coalesce(s.payment_claimed_at, now())
   WHERE s.id = v.settlement_id AND s.store_id = v.store_id;
  IF v_claimed IS NULL THEN
    INSERT INTO public.notifications (store_id, kind, data)
    VALUES (v.store_id, 'PAYMENT_CLAIMED', jsonb_build_object('settlement_id', v.settlement_id));
  END IF;
  RETURN jsonb_build_object('result', 'OK');
END;
$$;
REVOKE ALL ON FUNCTION public_settlement_receipt_attach(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_settlement_receipt_attach(text, text, text) TO public_runtime;
