-- 0008_acesso-e-convites: acesso somente por convite (ADR 0012) e credencial do
-- WhatsApp fora da tabela `stores`.
CREATE TYPE user_status AS ENUM ('INVITED', 'ACTIVE', 'SUSPENDED');
CREATE TYPE invitation_status AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED');

-- Contas existentes (seed e desenvolvimento) já eram usuários de fato: ACTIVE.
ALTER TABLE users
  ADD COLUMN name text,
  ADD COLUMN status user_status NOT NULL DEFAULT 'ACTIVE',
  ADD COLUMN is_platform_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN can_create_stores boolean NOT NULL DEFAULT false,
  ADD COLUMN store_limit integer NOT NULL DEFAULT 0,
  ADD COLUMN last_login_at timestamptz,
  ADD CONSTRAINT users_store_limit_nonneg CHECK (store_limit >= 0),
  -- Quem não pode criar lojas não tem limite.
  ADD CONSTRAINT users_store_limit_requires_permission
    CHECK (can_create_stores OR store_limit = 0);
-- Daqui em diante, uma conta nova nasce convidada e só vira ACTIVE ao aceitar.
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'INVITED';
CREATE INDEX users_status_idx ON users (status);

-- Sessões ativas do perfil: de onde e com que aparelho cada refresh foi emitido.
ALTER TABLE refresh_tokens
  ADD COLUMN user_agent text,
  ADD COLUMN ip text;

-- Convite: de proprietário ou do administrador. Guarda só o hash do token.
-- store_id e role vazios = convite só de conta (ex.: "Cadastrar usuário").
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL,
  email text NOT NULL,
  store_id uuid REFERENCES stores (id) ON DELETE CASCADE,
  role store_role,
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  status invitation_status NOT NULL DEFAULT 'PENDING',
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT invitations_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT invitations_permissions_is_object CHECK (jsonb_typeof(permissions) = 'object'),
  CONSTRAINT invitations_store_requires_role CHECK ((store_id IS NULL) = (role IS NULL)),
  CONSTRAINT invitations_accepted_at_matches_status
    CHECK ((status = 'ACCEPTED') = (accepted_at IS NOT NULL))
);
CREATE INDEX invitations_email_idx ON invitations (email);
CREATE INDEX invitations_store_idx ON invitations (store_id) WHERE store_id IS NOT NULL;

-- A sessão do WhatsApp é credencial: sai de `stores` para uma tabela que só o
-- contexto da própria loja enxerga (ADR 0007 e 0011). Assim nem um `select *`
-- em `stores` a carrega para a memória, para um log ou para o administrador.
CREATE TABLE whatsapp_sessions (
  store_id uuid PRIMARY KEY REFERENCES stores (id) ON DELETE CASCADE,
  session_data text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO whatsapp_sessions (store_id, session_data)
  SELECT id, whatsapp_session_data FROM stores WHERE whatsapp_session_data IS NOT NULL;
ALTER TABLE stores DROP COLUMN whatsapp_session_data;
