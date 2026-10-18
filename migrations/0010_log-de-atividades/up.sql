-- 0010_log-de-atividades: quem excluiu, aprovou ou alterou permissões (adendo do
-- design). Tabela de loja, imutável para a aplicação e legível só pelo proprietário.
CREATE TABLE activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  -- Quem agiu. Vazio se a conta for removida: o registro continua valendo.
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  -- Ex.: store.updated, member.removed, invitation.sent.
  action text NOT NULL,
  target_type text,
  target_id uuid,
  -- Só identificadores e valores técnicos. Sem e-mail, telefone, CPF ou texto livre de terceiros.
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_log_action_format CHECK (action ~ '^[a-z_]+\.[a-z_]+$'),
  CONSTRAINT activity_log_details_is_object CHECK (jsonb_typeof(details) = 'object')
);
CREATE INDEX activity_log_store_created_idx ON activity_log (store_id, created_at DESC, id DESC);

-- Só inserir e ler: sem UPDATE nem DELETE, a aplicação não consegue reescrever a história.
GRANT SELECT, INSERT ON activity_log TO app_runtime;

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log FORCE ROW LEVEL SECURITY;

-- Qualquer ação de uma loja pode registrar; o administrador da plataforma não grava aqui.
CREATE POLICY activity_log_insert ON activity_log FOR INSERT TO app_runtime
  WITH CHECK (store_id = app_current_store());

-- Ler: só o proprietário da loja do contexto (o banco confere o papel, não só a rota).
CREATE POLICY activity_log_select ON activity_log FOR SELECT TO app_runtime USING (
  store_id = app_current_store()
  AND EXISTS (
    SELECT 1 FROM store_members m
     WHERE m.store_id = activity_log.store_id
       AND m.user_id = app_current_user()
       AND m.role = 'OWNER'
  )
);
