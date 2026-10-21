-- 0028_whatsapp-pareamento: canal painel <-> bot para parear o WhatsApp pelo painel (shared#36, D20).
-- Aprovado pelo dono (desenho comentado em shared#36): tabela nova com RLS `owner_only`, privilégios do
-- `bot_runtime` e uma linha a mais no `purge_expired()`.
--
-- Uma linha por loja. A API grava o PEDIDO (`requested_at`); o bot lê o pedido, grava o QR de vida
-- curta (60 s) e a lista de grupos; a API devolve isso só ao proprietário. Nada de chamada direta
-- Backend -> bot. O QR liga a conta de WhatsApp de quem o escaneia ao bot, então só o proprietário da
-- loja do contexto o lê (o banco confere o papel, como no log de atividades).
CREATE TABLE whatsapp_pairing (
  store_id uuid PRIMARY KEY REFERENCES stores (id) ON DELETE CASCADE,
  requested_at timestamptz,
  requested_by uuid REFERENCES users (id) ON DELETE SET NULL,
  qr_code text,
  qr_expires_at timestamptz,
  groups jsonb,
  groups_updated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_pairing_qr_pair CHECK ((qr_code IS NULL) = (qr_expires_at IS NULL)),
  CONSTRAINT whatsapp_pairing_qr_size CHECK (qr_code IS NULL OR char_length(qr_code) <= 2048),
  CONSTRAINT whatsapp_pairing_groups_shape CHECK (
    groups IS NULL OR (jsonb_typeof(groups) = 'array' AND jsonb_array_length(groups) <= 500))
);
ALTER TABLE whatsapp_pairing ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_pairing FORCE ROW LEVEL SECURITY;

-- API: só o PROPRIETÁRIO da loja do contexto lê e grava. O administrador da plataforma não tem política.
GRANT SELECT, INSERT, UPDATE ON whatsapp_pairing TO app_runtime;
CREATE POLICY owner_only ON whatsapp_pairing TO app_runtime
  USING (store_id = app_current_store() AND EXISTS (
    SELECT 1 FROM store_members m
     WHERE m.store_id = whatsapp_pairing.store_id AND m.user_id = app_current_user() AND m.role = 'OWNER'))
  WITH CHECK (store_id = app_current_store() AND EXISTS (
    SELECT 1 FROM store_members m
     WHERE m.store_id = whatsapp_pairing.store_id AND m.user_id = app_current_user() AND m.role = 'OWNER'));

-- Bot: vê quais lojas pediram (só `store_id` e `requested_at`, sem o QR) e escreve o que produz. Não cria
-- linha, não apaga e não lê o QR nem a lista de volta.
GRANT SELECT (store_id, requested_at) ON whatsapp_pairing TO bot_runtime;
GRANT UPDATE (requested_at, qr_code, qr_expires_at, groups, groups_updated_at, updated_at)
  ON whatsapp_pairing TO bot_runtime;
-- Esta política cruza lojas DE PROPÓSITO, só para as que pediram: o bot precisa descobrir quem pediu sem
-- conhecer a loja antes (como `stores_bot_select` já faz).
CREATE POLICY bot_select ON whatsapp_pairing FOR SELECT TO bot_runtime
  USING (requested_at IS NOT NULL OR store_id = app_current_store());
CREATE POLICY bot_update ON whatsapp_pairing FOR UPDATE TO bot_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- Limpeza: o QR vencido não fica parado no banco se o bot cair (a API já nunca o devolve vencido), e o
-- pedido que ninguém atendeu em 10 minutos é descartado. Mesma função, mais um bloco.
CREATE OR REPLACE FUNCTION purge_expired(p_now timestamptz DEFAULT now()) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_sessions bigint;
  v_otps bigint;
  v_failures bigint;
  v_links bigint;
  v_invitations bigint;
  v_runs bigint;
  v_pairing bigint;
BEGIN
  WITH gone AS (
    DELETE FROM public.refresh_tokens t
     WHERE t.expires_at < p_now - interval '30 days'
        OR t.revoked_at < p_now - interval '30 days'
    RETURNING 1
  ) SELECT count(*) INTO v_sessions FROM gone;

  WITH cleared AS (
    UPDATE public.users u
       SET otp_hash = NULL, otp_expires_at = NULL, otp_attempts = 0
     WHERE u.otp_expires_at < p_now - interval '1 day'
    RETURNING 1
  ) SELECT count(*) INTO v_otps FROM cleared;

  WITH gone AS (
    DELETE FROM public.public_ip_failures f
     WHERE f.window_started_at < p_now - interval '1 day'
       AND coalesce(f.locked_until, '-infinity'::timestamptz) < p_now
    RETURNING 1
  ) SELECT count(*) INTO v_failures FROM gone;

  WITH gone AS (
    DELETE FROM public.public_links l
     WHERE l.expires_at < p_now - interval '90 days'
        OR l.revoked_at < p_now - interval '90 days'
    RETURNING 1
  ) SELECT count(*) INTO v_links FROM gone;

  WITH gone AS (
    DELETE FROM public.invitations i
     WHERE (i.status = 'REVOKED' AND i.created_at < p_now - interval '90 days')
        OR (i.status = 'PENDING' AND i.expires_at < p_now - interval '90 days')
    RETURNING 1
  ) SELECT count(*) INTO v_invitations FROM gone;

  WITH gone AS (
    DELETE FROM public.catalog_sync_runs r
     WHERE r.started_at < p_now - interval '180 days'
    RETURNING 1
  ) SELECT count(*) INTO v_runs FROM gone;

  -- QR de pareamento vencido (vive 60 s) e pedido que ninguém atendeu há mais de 10 minutos.
  WITH cleared AS (
    UPDATE public.whatsapp_pairing w
       SET qr_code = CASE WHEN w.qr_expires_at < p_now THEN NULL ELSE w.qr_code END,
           qr_expires_at = CASE WHEN w.qr_expires_at < p_now THEN NULL ELSE w.qr_expires_at END,
           requested_at = CASE WHEN w.requested_at < p_now - interval '10 minutes' THEN NULL ELSE w.requested_at END,
           updated_at = p_now
     WHERE w.qr_expires_at < p_now OR w.requested_at < p_now - interval '10 minutes'
    RETURNING 1
  ) SELECT count(*) INTO v_pairing FROM cleared;

  RETURN jsonb_build_object(
    'sessions', v_sessions,
    'otps_cleared', v_otps,
    'ip_failures', v_failures,
    'public_links', v_links,
    'invitations', v_invitations,
    'catalog_runs', v_runs,
    'whatsapp_pairing', v_pairing
  );
END;
$$;
