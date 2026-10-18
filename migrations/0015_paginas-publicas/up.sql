-- 0015_paginas-publicas: acesso público por link (ADR 0014, aprovado como D13).
--
-- Regras desta migration:
--  * O público NÃO consulta tabela. Existe um papel NOLOGIN `public_runtime` sem privilégio em
--    nenhuma tabela; ele só executa as funções `public_*` abaixo.
--  * As funções são SECURITY DEFINER (rodam como o dono do schema, que ignora o RLS) com
--    `search_path` fixo, e devolvem só os campos permitidos. Nenhuma política de RLS é afrouxada.
--  * O token do link tem 256 bits e só existe em hash (SHA-256). Link inexistente, expirado,
--    revogado, bloqueado ou com chave errada respondem exatamente igual: NULL.
--  * Tentativa errada conta por link (chave do consignador) e por IP, com bloqueio temporário.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_runtime') THEN
    CREATE ROLE public_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;
-- A API (app_runtime) assume este papel dentro da transação (SET LOCAL ROLE) nas rotas públicas.
GRANT public_runtime TO app_runtime WITH INHERIT FALSE, SET TRUE;

-- Chave PIX da loja, mostrada ao comprador na página do acerto.
ALTER TABLE stores
  ADD COLUMN pix_key text,
  ADD CONSTRAINT stores_pix_key_length CHECK (pix_key IS NULL OR char_length(pix_key) BETWEEN 1 AND 140);

CREATE TYPE public_link_kind AS ENUM ('SETTLEMENT', 'CONSIGNOR');

CREATE TABLE public_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  kind public_link_kind NOT NULL,
  settlement_id uuid,
  -- Consignador: o link é por consignador e por loja, não por carta.
  customer_id uuid,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT public_links_id_store_key UNIQUE (id, store_id),
  CONSTRAINT public_links_token_hash_key UNIQUE (token_hash),
  CONSTRAINT public_links_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT public_links_attempts_nonneg CHECK (failed_attempts >= 0),
  CONSTRAINT public_links_settlement_fkey FOREIGN KEY (settlement_id, store_id)
    REFERENCES settlements (id, store_id) ON DELETE CASCADE,
  CONSTRAINT public_links_customer_fkey FOREIGN KEY (customer_id, store_id)
    REFERENCES customers (id, store_id),
  CONSTRAINT public_links_target_matches_kind CHECK (
    (kind = 'SETTLEMENT' AND settlement_id IS NOT NULL AND customer_id IS NULL)
    OR (kind = 'CONSIGNOR' AND customer_id IS NOT NULL AND settlement_id IS NULL)
  )
);
CREATE INDEX public_links_store_kind_idx ON public_links (store_id, kind, created_at DESC);
CREATE INDEX public_links_settlement_idx ON public_links (settlement_id) WHERE settlement_id IS NOT NULL;
CREATE INDEX public_links_customer_idx ON public_links (customer_id) WHERE customer_id IS NOT NULL;

-- Consentimento LGPD de quem preenche o acerto: quem, quando, versão do texto e IP.
CREATE TABLE lgpd_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  customer_id uuid NOT NULL,
  settlement_id uuid NOT NULL,
  text_version text NOT NULL,
  ip inet,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lgpd_consents_customer_fkey FOREIGN KEY (customer_id, store_id)
    REFERENCES customers (id, store_id),
  CONSTRAINT lgpd_consents_settlement_fkey FOREIGN KEY (settlement_id, store_id)
    REFERENCES settlements (id, store_id) ON DELETE CASCADE,
  CONSTRAINT lgpd_consents_version_length CHECK (char_length(text_version) BETWEEN 1 AND 40)
);
CREATE INDEX lgpd_consents_customer_idx ON lgpd_consents (customer_id);

-- Falhas por IP (guardado em hash), para o bloqueio temporário. Fora do RLS e sem nenhum grant:
-- só as funções abaixo (dono) leem e gravam.
CREATE TABLE public_ip_failures (
  ip_hash text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  CONSTRAINT public_ip_failures_hash_format CHECK (ip_hash ~ '^[0-9a-f]{64}$')
);

-- A loja gerencia os próprios links; consentimento ela só lê (a gravação é da função pública).
GRANT SELECT, INSERT, UPDATE ON public_links TO app_runtime;
GRANT SELECT ON lgpd_consents TO app_runtime;
ALTER TABLE public_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_links FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON public_links TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());
ALTER TABLE lgpd_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE lgpd_consents FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON lgpd_consents TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());
ALTER TABLE public_ip_failures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_ip_failures FORCE ROW LEVEL SECURITY;

-- --- Ajudantes internos (ninguém de fora executa) -----------------------------------------------
CREATE FUNCTION public_hash(p_value text) RETURNS text
  LANGUAGE sql IMMUTABLE
  SET search_path = pg_catalog
  AS $$ SELECT encode(sha256(convert_to(coalesce(p_value, ''), 'UTF8')), 'hex') $$;

CREATE FUNCTION public_ip_blocked(p_ip text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM public.public_ip_failures f
       WHERE f.ip_hash = public.public_hash(p_ip) AND f.locked_until > now()
    )
  $$;

-- 20 falhas em 15 minutos bloqueiam o IP por 15 minutos.
CREATE FUNCTION public_register_failure(p_ip text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_hash text := public.public_hash(p_ip);
BEGIN
  DELETE FROM public.public_ip_failures
   WHERE window_started_at < now() - interval '1 day' AND coalesce(locked_until, now()) < now();
  INSERT INTO public.public_ip_failures AS f (ip_hash, failures, window_started_at)
  VALUES (v_hash, 1, now())
  ON CONFLICT (ip_hash) DO UPDATE SET
    failures = CASE WHEN f.window_started_at < now() - interval '15 minutes'
                    THEN 1 ELSE f.failures + 1 END,
    window_started_at = CASE WHEN f.window_started_at < now() - interval '15 minutes'
                             THEN now() ELSE f.window_started_at END,
    locked_until = CASE
      WHEN (CASE WHEN f.window_started_at < now() - interval '15 minutes'
                 THEN 1 ELSE f.failures + 1 END) >= 20
        THEN now() + interval '15 minutes'
      ELSE f.locked_until END;
END;
$$;

-- Resolve o link pelo token. NULL para qualquer problema (formato, IP bloqueado, desconhecido,
-- tipo errado, expirado, revogado, bloqueado): quem chama não distingue um do outro.
CREATE FUNCTION public_resolve_link(p_token text, p_kind public_link_kind, p_ip text)
RETURNS public_links
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v public.public_links%ROWTYPE;
BEGIN
  IF public.public_ip_blocked(p_ip) THEN
    RETURN NULL;
  END IF;
  IF p_token IS NULL OR p_token !~ '^[A-Za-z0-9_-]{43}$' THEN
    PERFORM public.public_register_failure(p_ip);
    RETURN NULL;
  END IF;
  SELECT * INTO v FROM public.public_links l
   WHERE l.token_hash = public.public_hash(p_token) AND l.kind = p_kind;
  IF NOT FOUND OR v.revoked_at IS NOT NULL OR v.expires_at <= now()
     OR (v.locked_until IS NOT NULL AND v.locked_until > now()) THEN
    PERFORM public.public_register_failure(p_ip);
    RETURN NULL;
  END IF;
  RETURN v;
END;
$$;

-- --- Funções públicas ---------------------------------------------------------------------------

-- Página do acerto: resumo das cartas e do frete, PIX da loja e o que já se sabe do comprador, com
-- máscara. Nunca devolve CPF inteiro, e-mail, telefone nem endereço completo.
CREATE FUNCTION public_settlement_view(p_token text, p_ip text) RETURNS jsonb
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

-- O comprador informa CPF e endereço, com consentimento registrado. A validação do CPF é feita pelo
-- Backend; aqui há só a defesa de formato. NULL = link inválido; senão {"result": ...}.
CREATE FUNCTION public_settlement_submit(
  p_token text,
  p_ip text,
  p_cpf text,
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
  IF p_cpf !~ '^[0-9]{11}$' OR p_cpf ~ '^(.)\1{10}$' OR p_zip !~ '^[0-9]{8}$'
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
     SET cpf = p_cpf, address_zip = p_zip, address_street = btrim(p_street),
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
  RETURN jsonb_build_object('result', 'OK');
END;
$$;

-- Acompanhamento do consignador. Token (no link) + os 4 primeiros dígitos do CPF (segundo fator).
-- Chave errada = mesmo NULL do link inválido. 5 erros bloqueiam o link por 15 minutos; o IP também
-- entra na contagem. Telefones sempre parciais; o repasse é só estimativa.
CREATE FUNCTION public_consignor_view(p_token text, p_key text, p_ip text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v public.public_links%ROWTYPE;
  v_cpf text;
  v_name text;
BEGIN
  v := public.public_resolve_link(p_token, 'CONSIGNOR', p_ip);
  IF v.id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT c.cpf, c.name INTO v_cpf, v_name
    FROM public.customers c WHERE c.id = v.customer_id AND c.store_id = v.store_id;
  IF p_key IS NULL OR p_key !~ '^[0-9]{4}$' OR v_cpf IS NULL OR left(v_cpf, 4) <> p_key THEN
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

-- --- Privilégios --------------------------------------------------------------------------------
-- Tudo fechado por padrão; o papel público só executa as quatro funções de entrada.
REVOKE ALL ON FUNCTION public_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_ip_blocked(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_register_failure(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_resolve_link(text, public_link_kind, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_settlement_view(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_settlement_submit(
  text, text, text, text, text, text, text, text, text, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public_consignor_view(text, text, text) FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO public_runtime;
GRANT EXECUTE ON FUNCTION public_settlement_view(text, text) TO public_runtime;
GRANT EXECUTE ON FUNCTION public_settlement_submit(
  text, text, text, text, text, text, text, text, text, boolean, text) TO public_runtime;
GRANT EXECUTE ON FUNCTION public_consignor_view(text, text, text) TO public_runtime;
