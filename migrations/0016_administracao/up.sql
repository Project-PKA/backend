-- 0016_administracao: área /admin da plataforma (ADR 0012).
--  * dados da loja que a administração define (cidade, plano, limite de membros);
--  * log de atividades da plataforma (o log da loja é só da loja: o admin não grava lá);
--  * solicitações de acesso vindas da landing (não criam usuário nem loja).

ALTER TABLE stores
  ADD COLUMN city text,
  ADD COLUMN plan text NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN member_limit integer NOT NULL DEFAULT 5,
  ADD CONSTRAINT stores_city_length CHECK (city IS NULL OR char_length(city) BETWEEN 1 AND 80),
  ADD CONSTRAINT stores_plan_format CHECK (plan ~ '^[A-Z][A-Z0-9_]{1,19}$'),
  ADD CONSTRAINT stores_member_limit_range CHECK (member_limit BETWEEN 1 AND 1000);

-- --- Log da plataforma -----------------------------------------------------------------------
CREATE TABLE admin_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Ex.: user.suspended, store.created.
  action text NOT NULL,
  target_type text,
  target_id uuid,
  -- Só ids e valores técnicos. Sem e-mail, telefone ou CPF.
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT admin_activity_log_action_format CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT admin_activity_log_details_is_object CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX admin_activity_log_created_idx ON admin_activity_log (created_at DESC, id DESC);

-- Só inserir e ler, e só o administrador da plataforma (o banco confere, não só a rota).
GRANT SELECT, INSERT ON admin_activity_log TO app_runtime;
ALTER TABLE admin_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_activity_log FORCE ROW LEVEL SECURITY;
CREATE POLICY admin_log_insert ON admin_activity_log FOR INSERT TO app_runtime
  WITH CHECK (app_is_platform_admin());
CREATE POLICY admin_log_select ON admin_activity_log FOR SELECT TO app_runtime
  USING (app_is_platform_admin());

-- --- Solicitações de acesso ------------------------------------------------------------------
CREATE TYPE access_request_status AS ENUM ('PENDING', 'REFUSED', 'CONVERTED');

CREATE TABLE access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  email text NOT NULL,
  whatsapp text,
  store_name text NOT NULL,
  message text,
  status access_request_status NOT NULL DEFAULT 'PENDING',
  -- IP em hash, só para limitar abuso do formulário público.
  ip_hash text NOT NULL,
  decided_by uuid REFERENCES users (id) ON DELETE SET NULL,
  decided_at timestamptz,
  converted_store_id uuid REFERENCES stores (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT access_requests_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT access_requests_sizes CHECK (
    char_length(name) BETWEEN 1 AND 120 AND char_length(email) BETWEEN 3 AND 254
    AND char_length(store_name) BETWEEN 1 AND 120
    AND (whatsapp IS NULL OR whatsapp ~ '^[0-9]{12,15}$')
    AND (message IS NULL OR char_length(message) <= 1000)
  ),
  CONSTRAINT access_requests_decision_matches_status CHECK (
    (status = 'PENDING') = (decided_at IS NULL)
  )
);
-- Pedido repetido do mesmo e-mail enquanto pendente não cria outra linha.
CREATE UNIQUE INDEX access_requests_pending_email_idx ON access_requests (email)
  WHERE status = 'PENDING';
CREATE INDEX access_requests_status_created_idx ON access_requests (status, created_at DESC, id DESC);
CREATE INDEX access_requests_ip_created_idx ON access_requests (ip_hash, created_at);

-- A aplicação lê e decide; quem GRAVA o pedido é a função pública abaixo (o público não toca tabela).
GRANT SELECT, UPDATE ON access_requests TO app_runtime;
ALTER TABLE access_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY access_requests_admin ON access_requests TO app_runtime
  USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

-- Recebe um pedido do formulário público. Não devolve nada que diferencie pedido novo, repetido ou
-- descartado por abuso (mesma resposta, ADR 0012). 10 pedidos por IP em 24 horas, e 200 pedidos
-- pendentes no total, são o teto; passou disso, descarta em silêncio. Não envia e-mail a ninguém.
CREATE FUNCTION public_access_request_submit(
  p_name text,
  p_email text,
  p_whatsapp text,
  p_store_name text,
  p_message text,
  p_ip text
) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
DECLARE
  v_hash text := public.public_hash(p_ip);
  v_email text := lower(btrim(coalesce(p_email, '')));
BEGIN
  IF char_length(btrim(coalesce(p_name, ''))) NOT BETWEEN 1 AND 120
     OR char_length(btrim(coalesce(p_store_name, ''))) NOT BETWEEN 1 AND 120
     OR v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' OR char_length(v_email) > 254
     OR (p_whatsapp IS NOT NULL AND p_whatsapp !~ '^[0-9]{12,15}$')
     OR char_length(coalesce(p_message, '')) > 1000 THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM public.access_requests r
       WHERE r.ip_hash = v_hash AND r.created_at > now() - interval '24 hours') >= 10
     OR (SELECT count(*) FROM public.access_requests r WHERE r.status = 'PENDING') >= 200 THEN
    RETURN;
  END IF;
  INSERT INTO public.access_requests (name, email, whatsapp, store_name, message, ip_hash)
  VALUES (btrim(p_name), v_email, p_whatsapp, btrim(p_store_name), nullif(btrim(coalesce(p_message, '')), ''), v_hash)
  ON CONFLICT (email) WHERE status = 'PENDING' DO NOTHING;
END;
$$;
REVOKE ALL ON FUNCTION public_access_request_submit(text, text, text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_access_request_submit(text, text, text, text, text, text)
  TO public_runtime;
