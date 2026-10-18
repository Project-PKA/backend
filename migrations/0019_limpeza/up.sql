-- 0019_limpeza: limpeza automática do que vence (e só do que é técnico e efêmero).
--
-- `purge_expired()` apaga, em todas as lojas, dado que perdeu a utilidade:
--   sessões (refresh tokens) vencidas ou revogadas há mais de 30 dias;
--   códigos de login (OTP) vencidos há mais de um dia;
--   falhas de acesso público por IP fora da janela de bloqueio;
--   links públicos vencidos ou revogados há mais de 90 dias;
--   convites revogados, ou pendentes e vencidos, há mais de 90 dias (os aceitos ficam: são histórico);
--   execuções do sync do catálogo com mais de 180 dias.
-- Fica DE FORA, de propósito: pedido de acesso, aviso interno e qualquer dado pessoal de cliente. O
-- prazo de retenção deles é a decisão de LGPD (shared/OWNER.md, D2); o log de atividades é imutável.
--
-- É SECURITY DEFINER porque a API (app_runtime) não tem DELETE nessas tabelas e várias são de
-- escopo global ou de loja (RLS). Só `app_runtime` executa; o público não.
CREATE FUNCTION purge_expired(p_now timestamptz DEFAULT now()) RETURNS jsonb
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

  RETURN jsonb_build_object(
    'sessions', v_sessions,
    'otps_cleared', v_otps,
    'ip_failures', v_failures,
    'public_links', v_links,
    'invitations', v_invitations,
    'catalog_runs', v_runs
  );
END;
$$;
REVOKE ALL ON FUNCTION purge_expired(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_expired(timestamptz) TO app_runtime;
