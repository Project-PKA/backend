-- 0002_identidade: usuários, sessão, lojas e equipe (ADR 0008).
CREATE TYPE store_role AS ENUM ('OWNER', 'STAFF');
CREATE TYPE whatsapp_status AS ENUM ('ONLINE', 'OFFLINE', 'QR_READY');

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  -- Hash do OTP (nunca o código em texto puro), com expiração e contador de tentativas.
  otp_hash text,
  otp_expires_at timestamptz,
  otp_attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT users_otp_attempts_nonneg CHECK (otp_attempts >= 0)
);

-- Refresh token rotacionado a cada uso; guarda só o hash, para permitir revogar.
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refresh_tokens_token_hash_key UNIQUE (token_hash)
);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);

CREATE TABLE stores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  -- Credencial da sessão do WhatsApp: guardada CRIPTOGRAFADA (ADR 0007).
  whatsapp_session_data text,
  whatsapp_group_id text,
  whatsapp_status whatsapp_status NOT NULL DEFAULT 'OFFLINE',
  inactivity_days_limit integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stores_name_not_blank CHECK (btrim(name) <> ''),
  CONSTRAINT stores_inactivity_days_positive
    CHECK (inactivity_days_limit IS NULL OR inactivity_days_limit > 0)
);

CREATE TABLE store_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES stores (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role store_role NOT NULL,
  permissions jsonb NOT NULL DEFAULT '{"can_delete": false}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_members_store_user_key UNIQUE (store_id, user_id),
  CONSTRAINT store_members_permissions_is_object CHECK (jsonb_typeof(permissions) = 'object')
);
CREATE INDEX store_members_user_id_idx ON store_members (user_id);
