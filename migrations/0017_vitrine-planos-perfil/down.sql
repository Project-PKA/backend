-- 0017_vitrine-planos-perfil: reverte.
DROP FUNCTION public_showcase_list(uuid, text, text, integer, integer);
-- Volta a função do acerto à versão da migration 0015 (sem a notificação).
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
  RETURN jsonb_build_object('result', 'OK');
END;
$$;

DROP TABLE notification_reads;
DROP TABLE notifications;
DROP TABLE plan_change_requests;
DROP TYPE plan_request_status;
DROP INDEX stores_showcase_idx;
ALTER TABLE stores
  DROP CONSTRAINT stores_showcase_requires_invite,
  DROP CONSTRAINT stores_invite_url_format,
  DROP CONSTRAINT stores_card_limit_range,
  DROP COLUMN whatsapp_invite_url,
  DROP COLUMN showcase_enabled,
  DROP COLUMN card_limit;
ALTER TABLE users
  DROP CONSTRAINT users_notification_prefs_is_object,
  DROP CONSTRAINT users_currency_allowed,
  DROP CONSTRAINT users_timezone_format,
  DROP CONSTRAINT users_theme_allowed,
  DROP CONSTRAINT users_language_allowed,
  DROP COLUMN notification_prefs,
  DROP COLUMN currency,
  DROP COLUMN timezone,
  DROP COLUMN theme,
  DROP COLUMN language;
