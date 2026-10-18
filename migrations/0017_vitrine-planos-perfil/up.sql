-- 0017_vitrine-planos-perfil: preferências do usuário, limites e pedidos de mudança de plano,
-- notificações internas e vitrine pública (opt-in da loja).

-- --- Preferências do usuário ---------------------------------------------------------------------
ALTER TABLE users
  ADD COLUMN language text NOT NULL DEFAULT 'pt-BR',
  ADD COLUMN theme text NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN currency text NOT NULL DEFAULT 'BRL',
  ADD COLUMN notification_prefs jsonb NOT NULL DEFAULT '{"in_app": true, "email": false}'::jsonb,
  ADD CONSTRAINT users_language_allowed CHECK (language IN ('pt-BR', 'en')),
  ADD CONSTRAINT users_theme_allowed CHECK (theme IN ('LIGHT', 'DARK', 'SYSTEM')),
  ADD CONSTRAINT users_timezone_format CHECK (timezone ~ '^[A-Za-z][A-Za-z0-9_+/-]{1,63}$'),
  ADD CONSTRAINT users_currency_allowed CHECK (currency IN ('BRL')),
  ADD CONSTRAINT users_notification_prefs_is_object CHECK (jsonb_typeof(notification_prefs) = 'object');

-- --- Loja: limite de cartas, vitrine e link do grupo ----------------------------------------------
ALTER TABLE stores
  ADD COLUMN card_limit integer,
  ADD COLUMN showcase_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN whatsapp_invite_url text,
  ADD CONSTRAINT stores_card_limit_range CHECK (card_limit IS NULL OR card_limit BETWEEN 1 AND 1000000),
  ADD CONSTRAINT stores_invite_url_format CHECK (
    whatsapp_invite_url IS NULL OR whatsapp_invite_url ~ '^https://chat\.whatsapp\.com/[A-Za-z0-9]{10,40}$'
  ),
  -- A vitrine leva ao grupo: sem o link do grupo, não há vitrine.
  ADD CONSTRAINT stores_showcase_requires_invite CHECK (NOT showcase_enabled OR whatsapp_invite_url IS NOT NULL);
CREATE INDEX stores_showcase_idx ON stores (id) WHERE showcase_enabled;

-- --- Pedidos de mudança de plano --------------------------------------------------------------------
CREATE TYPE plan_request_status AS ENUM ('PENDING', 'APPLIED', 'REFUSED');

CREATE TABLE plan_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  requested_plan text,
  message text,
  status plan_request_status NOT NULL DEFAULT 'PENDING',
  requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_change_requests_plan_format
    CHECK (requested_plan IS NULL OR requested_plan ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  CONSTRAINT plan_change_requests_message_length CHECK (message IS NULL OR char_length(message) <= 1000),
  CONSTRAINT plan_change_requests_decision_matches_status CHECK ((status = 'PENDING') = (decided_at IS NULL))
);
CREATE INDEX plan_change_requests_store_idx ON plan_change_requests (store_id, created_at DESC);
CREATE INDEX plan_change_requests_status_idx ON plan_change_requests (status, created_at DESC, id DESC);
-- Um pedido pendente por loja: pedir de novo atualiza o que já está na fila.
CREATE UNIQUE INDEX plan_change_requests_one_pending_idx ON plan_change_requests (store_id)
  WHERE status = 'PENDING';

GRANT SELECT, INSERT, UPDATE ON plan_change_requests TO app_runtime;
ALTER TABLE plan_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_change_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON plan_change_requests TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());
-- A administração vê e decide os pedidos de todas as lojas (e só isso: não toca dado interno).
CREATE POLICY plan_requests_admin ON plan_change_requests TO app_runtime
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

-- --- Notificações internas ----------------------------------------------------------------------------
CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  -- Código do aviso; o texto é do frontend (l10n). Ex.: POLL_CEILING_REACHED.
  kind text NOT NULL,
  -- Só ids. Nunca nome, telefone, CPF ou texto de terceiros.
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_id_store_key UNIQUE (id, store_id),
  CONSTRAINT notifications_kind_format CHECK (kind ~ '^[A-Z][A-Z0-9_]{2,39}$'),
  CONSTRAINT notifications_data_is_object CHECK (jsonb_typeof(data) = 'object')
);
CREATE INDEX notifications_store_created_idx ON notifications (store_id, created_at DESC, id DESC);

-- Cada pessoa lê no seu ritmo: a leitura é por usuário, não da loja inteira.
CREATE TABLE notification_reads (
  notification_id uuid NOT NULL,
  store_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id),
  CONSTRAINT notification_reads_notification_fkey FOREIGN KEY (notification_id, store_id)
    REFERENCES notifications (id, store_id) ON DELETE CASCADE
);

GRANT SELECT, INSERT ON notifications TO app_runtime;
GRANT SELECT, INSERT ON notification_reads TO app_runtime;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON notifications TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());
ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON notification_reads TO app_runtime
  USING (store_id = app_current_store() AND user_id = app_current_user())
  WITH CHECK (store_id = app_current_store() AND user_id = app_current_user());

-- A página pública do acerto avisa a loja quando o comprador envia os dados.
CREATE OR REPLACE FUNCTION public_settlement_submit(
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
  -- Avisa a loja (notificação interna). Só ids.
  INSERT INTO public.notifications (store_id, kind, data)
  VALUES (v.store_id, 'BUYER_DATA_SUBMITTED',
          jsonb_build_object('settlement_id', v.settlement_id, 'customer_id', v_customer));
  RETURN jsonb_build_object('result', 'OK');
END;
$$;

-- --- Vitrine pública -------------------------------------------------------------------------------------
-- Leilões ao vivo das lojas que optaram pela vitrine e estão com o WhatsApp conectado. Sem login e
-- sem token, então o teto contra coleta em massa é estrutural: página de no máximo 48 itens e
-- deslocamento de no máximo 480 (a rota ainda limita as requisições por minuto). Nunca devolve
-- telefone, nome de cliente nem dado da loja além do nome, da cidade e do link do grupo.
CREATE FUNCTION public_showcase_list(
  p_store uuid,
  p_language text,
  p_sort text,
  p_limit integer,
  p_offset integer
) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_limit integer := least(greatest(coalesce(p_limit, 24), 1), 48);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 480);
  v_sort text := CASE WHEN p_sort IN ('ENDING_SOON', 'HIGHEST_BID', 'MOST_BIDS', 'NEWEST')
                      THEN p_sort ELSE 'ENDING_SOON' END;
BEGIN
  RETURN (
    WITH live AS (
      SELECT a.id AS auction_id, a.start_time, a.end_time, c.short_code, c.condition, c.language,
             c.is_foil, t.name AS card_name, t.card_number, t.set_name, t.raw_data,
             s.id AS store_id, s.name AS store_name, s.city, s.whatsapp_invite_url,
             top.amount AS top_amount, coalesce(top.total, 0) AS bid_total, top.last_at
        FROM public.auctions a
        JOIN public.stores s ON s.id = a.store_id
        JOIN public.cards_inventory c ON c.id = a.card_id AND c.store_id = a.store_id
        JOIN public.tcgdex_catalog t ON t.id = c.tcgdex_id
        LEFT JOIN LATERAL (
          SELECT max(b.amount) AS amount, count(*) AS total, max(b.created_at) AS last_at
            FROM public.bids b WHERE b.auction_id = a.id AND b.store_id = a.store_id) top ON true
       WHERE s.showcase_enabled AND s.whatsapp_status = 'ONLINE' AND s.whatsapp_invite_url IS NOT NULL
         AND a.status = 'ACTIVE' AND a.start_time <= now() AND a.end_time > now()
         AND (p_store IS NULL OR a.store_id = p_store)
         AND (p_language IS NULL OR c.language = p_language)
    ),
    page AS (
      SELECT * FROM live
       ORDER BY
         CASE WHEN v_sort = 'ENDING_SOON' THEN extract(epoch FROM end_time) END ASC NULLS LAST,
         CASE WHEN v_sort = 'HIGHEST_BID' THEN top_amount END DESC NULLS LAST,
         CASE WHEN v_sort = 'MOST_BIDS' THEN bid_total END DESC NULLS LAST,
         CASE WHEN v_sort = 'NEWEST' THEN extract(epoch FROM start_time) END DESC NULLS LAST,
         end_time ASC, auction_id ASC
       LIMIT v_limit OFFSET v_offset
    )
    SELECT jsonb_build_object(
      'items', coalesce((
        SELECT jsonb_agg(jsonb_build_object(
          'store', jsonb_build_object('id', store_id, 'name', store_name, 'city', city,
                                      'group_url', whatsapp_invite_url),
          'card', jsonb_build_object(
            'short_code', short_code, 'name', card_name, 'number', card_number, 'set_name', set_name,
            'condition', condition, 'language', language, 'is_foil', is_foil,
            'image_url', CASE WHEN raw_data -> 'images' ->> 'en' IS NULL THEN NULL
                              ELSE (raw_data -> 'images' ->> 'en') || '/low.webp' END),
          'current_bid', top_amount::numeric(12, 2)::text,
          'bid_count', bid_total,
          'last_bid_at', last_at,
          'ends_at', end_time)
          ORDER BY CASE WHEN v_sort = 'ENDING_SOON' THEN extract(epoch FROM end_time) END ASC NULLS LAST,
                   CASE WHEN v_sort = 'HIGHEST_BID' THEN top_amount END DESC NULLS LAST,
                   CASE WHEN v_sort = 'MOST_BIDS' THEN bid_total END DESC NULLS LAST,
                   CASE WHEN v_sort = 'NEWEST' THEN extract(epoch FROM start_time) END DESC NULLS LAST,
                   end_time ASC, auction_id ASC)
          FROM page), '[]'::jsonb),
      'total', (SELECT count(*) FROM live),
      'stores', coalesce((
        SELECT jsonb_agg(jsonb_build_object('id', x.store_id, 'name', x.store_name) ORDER BY x.store_name)
          FROM (SELECT DISTINCT store_id, store_name FROM live) x), '[]'::jsonb)
    )
  );
END;
$$;
REVOKE ALL ON FUNCTION public_showcase_list(uuid, text, text, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_showcase_list(uuid, text, text, integer, integer) TO public_runtime;
