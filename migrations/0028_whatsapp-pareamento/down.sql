-- 0028_whatsapp-pareamento: reverte. O pedido, o QR e a lista de grupos em andamento se perdem.
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
DROP TABLE whatsapp_pairing;
