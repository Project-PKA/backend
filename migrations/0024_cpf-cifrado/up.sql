-- 0024_cpf-cifrado: o CPF deixa de ficar legível no banco (ADR 0019 do shared, decisão do dono em OWNER.md D2).
--
-- `customers.cpf` passa a guardar o CPF cifrado pela API (AES-256-GCM, `v1.<iv>.<tag>.<texto>`). Duas colunas
-- derivadas permitem o que o SQL ainda precisa, sem expor o CPF: `cpf_last2` (a máscara) e `cpf_key_hash`
-- (HMAC dos 4 primeiros dígitos, a chave de acesso do consignador). A cifra e o HMAC usam a chave
-- `CPF_ENCRYPTION_KEY`, que o banco não conhece.
--
-- Linhas antigas, com o CPF legível, ficam com `cpf_last2` preenchido aqui e são cifradas pelo comando
-- `npm run db:encrypt-cpf` (que também preenche `cpf_key_hash`). Até lá o consignador dessas linhas não acessa o link.
ALTER TABLE customers ADD COLUMN cpf_last2 text;
ALTER TABLE customers ADD COLUMN cpf_key_hash text;

-- A tabela tem FORCE RLS e a política vale só para `app_runtime`: solta o FORCE por um instante.
ALTER TABLE customers NO FORCE ROW LEVEL SECURITY;
UPDATE customers SET cpf_last2 = right(cpf, 2) WHERE cpf ~ '^[0-9]{11}$';
ALTER TABLE customers FORCE ROW LEVEL SECURITY;

ALTER TABLE customers ADD CONSTRAINT customers_cpf_last2_format
  CHECK (cpf_last2 IS NULL OR cpf_last2 ~ '^[0-9]{2}$');
ALTER TABLE customers ADD CONSTRAINT customers_cpf_key_hash_format
  CHECK (cpf_key_hash IS NULL OR cpf_key_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE customers ADD CONSTRAINT customers_cpf_has_last2
  CHECK (cpf IS NULL OR cpf_last2 IS NOT NULL);

-- Página do acerto: a máscara sai de `cpf_last2`.
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
                           ELSE '•••.•••.•••-' || cu.cpf_last2 END,
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

-- Envio dos dados do comprador: recebe o CPF já cifrado, os 2 últimos dígitos e o hash dos 4 primeiros.
-- A validade do CPF (dígitos verificadores) é conferida pela API antes de cifrar.
DROP FUNCTION public_settlement_submit(
  text, text, text, text, text, text, text, text, text, boolean, text);
CREATE FUNCTION public_settlement_submit(
  p_token text,
  p_ip text,
  p_cpf text,
  p_cpf_last2 text,
  p_cpf_key_hash text,
  p_zip text,
  p_street text,
  p_number text,
  p_comp text,
  p_city text,
  p_state text,
  p_consent boolean,
  p_consent_version text
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v public.public_links%ROWTYPE;
  v_customer uuid;
  v_ip inet;
BEGIN
  v := public.public_resolve_link(p_token, 'SETTLEMENT', p_ip);
  IF v.id IS NULL THEN
    RETURN NULL;
  END IF;
  IF p_consent IS NOT TRUE OR p_consent_version IS NULL
     OR char_length(p_consent_version) NOT BETWEEN 1 AND 40 THEN
    RETURN jsonb_build_object('result', 'CONSENT_REQUIRED');
  END IF;
  IF p_cpf !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
     OR p_cpf_last2 !~ '^[0-9]{2}$' OR p_cpf_key_hash !~ '^[0-9a-f]{64}$'
     OR p_zip !~ '^[0-9]{8}$'
     OR p_state !~ '^[A-Z]{2}$'
     OR coalesce(btrim(p_street), '') = '' OR coalesce(btrim(p_number), '') = ''
     OR coalesce(btrim(p_city), '') = ''
     OR char_length(p_street) > 120 OR char_length(p_number) > 20
     OR char_length(coalesce(p_comp, '')) > 60 OR char_length(p_city) > 80 THEN
    RETURN jsonb_build_object('result', 'INVALID_DATA');
  END IF;

  SELECT s.customer_id INTO v_customer
    FROM public.settlements s WHERE s.id = v.settlement_id AND s.store_id = v.store_id;
  UPDATE public.customers c
     SET cpf = p_cpf, cpf_last2 = p_cpf_last2, cpf_key_hash = p_cpf_key_hash,
         address_zip = p_zip, address_street = btrim(p_street),
         address_number = btrim(p_number), address_comp = nullif(btrim(coalesce(p_comp, '')), ''),
         address_city = btrim(p_city), address_state = p_state,
         is_visitor = false, updated_at = now()
   WHERE c.id = v_customer AND c.store_id = v.store_id;

  BEGIN
    v_ip := p_ip::inet;
  EXCEPTION WHEN invalid_text_representation THEN
    v_ip := NULL;
  END;
  INSERT INTO public.lgpd_consents (store_id, customer_id, settlement_id, text_version, ip)
  VALUES (v.store_id, v_customer, v.settlement_id, p_consent_version, v_ip);
  -- Só ids: nunca CPF nem endereço no log.
  INSERT INTO public.activity_log (store_id, actor_user_id, action, target_type, target_id, details)
  VALUES (v.store_id, NULL, 'settlement.buyer_data_submitted', 'settlement', v.settlement_id,
          jsonb_build_object('customer_id', v_customer));
  -- Avisa a loja (notificação interna). Só ids.
  INSERT INTO public.notifications (store_id, kind, data)
  VALUES (v.store_id, 'BUYER_DATA_SUBMITTED',
          jsonb_build_object('settlement_id', v.settlement_id, 'customer_id', v_customer));
  RETURN jsonb_build_object('result', 'OK');
END;
$$;
REVOKE ALL ON FUNCTION public_settlement_submit(
  text, text, text, text, text, text, text, text, text, text, text, boolean, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_settlement_submit(
  text, text, text, text, text, text, text, text, text, text, text, boolean, text) TO public_runtime;

-- Acompanhamento do consignador: `p_key` agora é o HMAC (hex) dos 4 primeiros dígitos, calculado pela API.
-- Chave errada continua sendo o mesmo NULL do link inválido, com a mesma contagem de tentativas.
CREATE OR REPLACE FUNCTION public_consignor_view(p_token text, p_key text, p_ip text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v public.public_links%ROWTYPE;
  v_key_hash text;
  v_name text;
BEGIN
  v := public.public_resolve_link(p_token, 'CONSIGNOR', p_ip);
  IF v.id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT c.cpf_key_hash, c.name INTO v_key_hash, v_name
    FROM public.customers c WHERE c.id = v.customer_id AND c.store_id = v.store_id;
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' OR v_key_hash IS NULL OR v_key_hash <> p_key THEN
    UPDATE public.public_links l
       SET failed_attempts = CASE WHEN l.failed_attempts + 1 >= 5 THEN 0 ELSE l.failed_attempts + 1 END,
           locked_until = CASE WHEN l.failed_attempts + 1 >= 5
                               THEN now() + interval '15 minutes' ELSE l.locked_until END
     WHERE l.id = v.id;
    PERFORM public.public_register_failure(p_ip);
    RETURN NULL;
  END IF;
  UPDATE public.public_links l SET failed_attempts = 0 WHERE l.id = v.id AND l.failed_attempts <> 0;

  RETURN jsonb_build_object(
    'store_name', (SELECT st.name FROM public.stores st WHERE st.id = v.store_id),
    'first_name', split_part(v_name, ' ', 1),
    'expires_at', v.expires_at,
    'estimate_is_final', false,
    'cards', coalesce((
      SELECT jsonb_agg(card_row ORDER BY card_row ->> 'short_code')
        FROM (
          SELECT jsonb_build_object(
            'short_code', c.short_code,
            'name', t.name,
            'number', t.card_number,
            'condition', c.condition,
            'language', c.language,
            'card_status', c.status,
            'commission_pct', c.store_commission_pct::numeric(5, 2)::text,
            'auction', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object(
              'status', a.status,
              'ends_at', a.end_time,
              'current_bid', top.amount::numeric(12, 2)::text,
              'bid_count', coalesce(top.total, 0),
              'estimated_payout', CASE WHEN top.amount IS NULL THEN NULL
                ELSE (top.amount - round(top.amount * c.store_commission_pct / 100, 2))::numeric(12, 2)::text END,
              'bids', coalesce((
                SELECT jsonb_agg(jsonb_build_object(
                         'amount', b.amount::numeric(12, 2)::text, 'at', b.created_at,
                         'phone', left(cu.phone, 5) || repeat('•', greatest(char_length(cu.phone) - 7, 0))
                                  || right(cu.phone, 2)) ORDER BY b.amount DESC)
                  FROM (SELECT * FROM public.bids bb
                         WHERE bb.auction_id = a.id AND bb.store_id = a.store_id
                         ORDER BY bb.amount DESC LIMIT 20) b
                  JOIN public.customers cu ON cu.id = b.customer_id AND cu.store_id = b.store_id),
                '[]'::jsonb)) END) AS card_row
            FROM public.cards_inventory c
            JOIN public.tcgdex_catalog t ON t.id = c.tcgdex_id
            LEFT JOIN LATERAL (
              SELECT x.* FROM public.auctions x
               WHERE x.card_id = c.id AND x.store_id = c.store_id AND x.status <> 'CANCELLED'
               ORDER BY (x.status IN ('PENDING', 'ACTIVE', 'PAUSED_FOR_VALIDATION')) DESC, x.end_time DESC
               LIMIT 1) a ON true
            LEFT JOIN LATERAL (
              SELECT max(bb.amount) AS amount, count(*) AS total FROM public.bids bb
               WHERE bb.auction_id = a.id AND bb.store_id = a.store_id) top ON a.id IS NOT NULL
           WHERE c.store_id = v.store_id AND c.consignor_id = v.customer_id
           ORDER BY c.created_at DESC LIMIT 50
        ) cards), '[]'::jsonb)
  );
END;
$$;
