-- 0009_rls-e-papeis: Row-Level Security como segunda barreira de isolamento
-- (ADR 0011) e fronteira do administrador da plataforma (ADR 0012).
--
-- Papéis (cluster inteiro, por isso criados só se não existirem):
--   owner/migração   dono do schema; BYPASSRLS ou superusuário; só no deploy e no seed.
--   app_runtime      grupo NOLOGIN do Backend em execução; sujeito ao RLS.
-- O usuário que conecta (LOGIN, com senha) é criado fora da migration, na
-- provisão do ambiente, e entra em app_runtime. Senha nunca fica em migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Contexto da transação, definido pelo Backend com set_config(..., true).
-- Sem contexto o valor é NULL e as políticas não deixam passar nenhuma linha.
CREATE FUNCTION app_current_store() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.store_id', true), '')::uuid $$;

CREATE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION app_is_platform_admin() RETURNS boolean
  LANGUAGE sql STABLE
  AS $$ SELECT coalesce(nullif(current_setting('app.is_platform_admin', true), '')::boolean, false) $$;

-- --- Grants mínimos -----------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT EXECUTE ON FUNCTION app_current_store(), app_current_user(), app_is_platform_admin()
  TO app_runtime;

GRANT SELECT, INSERT, UPDATE ON users, invitations TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON refresh_tokens TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON stores TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON store_members, whatsapp_sessions TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON tcgdex_catalog TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON customers, cards_inventory, auctions, settlements, settlement_items TO app_runtime;
-- Lance é histórico: não se apaga.
GRANT SELECT, INSERT, UPDATE ON bids TO app_runtime;

-- --- Tabelas de loja: só a loja do contexto ----------------------------------
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON customers TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

ALTER TABLE cards_inventory ENABLE ROW LEVEL SECURITY;
ALTER TABLE cards_inventory FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON cards_inventory TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

ALTER TABLE auctions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auctions FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON auctions TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

ALTER TABLE bids ENABLE ROW LEVEL SECURITY;
ALTER TABLE bids FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON bids TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlements FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON settlements TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

ALTER TABLE settlement_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE settlement_items FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON settlement_items TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- Credencial do WhatsApp: só com o contexto da própria loja. O administrador da
-- plataforma NÃO a enxerga.
ALTER TABLE whatsapp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY store_isolation ON whatsapp_sessions TO app_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- --- Lojas e equipe -----------------------------------------------------------
-- Enxerga a loja do contexto, as lojas de que o usuário do contexto participa
-- (para listar antes de escolher uma) e, só o administrador, todas.
-- Cria loja: o Backend define app.store_id com o id novo antes do INSERT.
ALTER TABLE stores ENABLE ROW LEVEL SECURITY;
ALTER TABLE stores FORCE ROW LEVEL SECURITY;
CREATE POLICY stores_select ON stores FOR SELECT TO app_runtime USING (
  id = app_current_store()
  OR app_is_platform_admin()
  OR id IN (SELECT store_id FROM store_members WHERE user_id = app_current_user())
);
CREATE POLICY stores_insert ON stores FOR INSERT TO app_runtime
  WITH CHECK (id = app_current_store() OR app_is_platform_admin());
CREATE POLICY stores_update ON stores FOR UPDATE TO app_runtime
  USING (id = app_current_store() OR app_is_platform_admin())
  WITH CHECK (id = app_current_store() OR app_is_platform_admin());

ALTER TABLE store_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE store_members FORCE ROW LEVEL SECURITY;
CREATE POLICY store_members_select ON store_members FOR SELECT TO app_runtime USING (
  store_id = app_current_store()
  OR user_id = app_current_user()
  OR app_is_platform_admin()
);
CREATE POLICY store_members_write ON store_members FOR INSERT TO app_runtime
  WITH CHECK (store_id = app_current_store() OR app_is_platform_admin());
CREATE POLICY store_members_update ON store_members FOR UPDATE TO app_runtime
  USING (store_id = app_current_store() OR app_is_platform_admin())
  WITH CHECK (store_id = app_current_store() OR app_is_platform_admin());
CREATE POLICY store_members_delete ON store_members FOR DELETE TO app_runtime
  USING (store_id = app_current_store() OR app_is_platform_admin());

-- `users`, `refresh_tokens`, `invitations` e `tcgdex_catalog` ficam fora do RLS: são
-- acessadas pelo fluxo de autenticação e de convite (antes de haver loja no
-- contexto) ou são globais. O filtro está no código, com teste.
