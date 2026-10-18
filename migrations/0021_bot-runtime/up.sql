-- 0021_bot-runtime: papel de banco do bot de WhatsApp (aprovado em OWNER.md D15, shared#16; ADR 0007,
-- 0011 e 0015).
--
-- `bot_runtime` é um grupo NOLOGIN, sem BYPASSRLS, como `app_runtime` e `public_runtime`. O usuário
-- que conecta (LOGIN, com senha) é criado fora da migration, na provisão do ambiente, e entra no
-- grupo. O bot define `app.store_id` por transação e só enxerga a loja do contexto.
--
-- O que ele faz: ler o leilão ativo e a carta, achar ou criar o visitante pelo telefone, registrar o
-- lance (`place_bid`), virar o estado dos leilões (`advance_auctions`) e atualizar o estado da
-- conexão do WhatsApp. Por isso o acesso é mínimo, por COLUNA onde o necessário é menor que a tabela:
-- nada de CPF, e-mail, endereço, chave PIX, acertos, envios, equipe, usuários nem log da plataforma.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bot_runtime') THEN
    CREATE ROLE bot_runtime NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO bot_runtime;
GRANT EXECUTE ON FUNCTION app_current_store() TO bot_runtime;

-- Lojas: só o necessário para saber quais sessões abrir. Sem estado de plano, PIX, cidade ou limites.
-- Escrever o estado do WhatsApp passa pela função `bot_set_whatsapp_status` (abaixo), nunca UPDATE.
GRANT SELECT (id, name, whatsapp_group_id, whatsapp_status) ON stores TO bot_runtime;
CREATE POLICY stores_bot_select ON stores FOR SELECT TO bot_runtime USING (true);

-- Credencial da sessão do WhatsApp: só a da loja do contexto.
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_sessions TO bot_runtime;
CREATE POLICY bot_store_isolation ON whatsapp_sessions TO bot_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- Leilões: lê tudo; `place_bid` e `advance_auctions` (SECURITY INVOKER) mudam estado, vencedor e alerta.
GRANT SELECT ON auctions TO bot_runtime;
GRANT UPDATE (status, winning_bid_id, max_value_reached_alert) ON auctions TO bot_runtime;
CREATE POLICY bot_store_isolation ON auctions TO bot_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- Lances: lê e grava; lance é histórico, não se apaga nem se edita.
GRANT SELECT, INSERT ON bids TO bot_runtime;
CREATE POLICY bot_store_isolation ON bids TO bot_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- Cartas: o que a legenda e a foto precisam; só o estado muda (`advance_auctions`).
GRANT SELECT (id, store_id, short_code, tcgdex_id, language, condition, is_foil, custom_photos, notes, status)
  ON cards_inventory TO bot_runtime;
GRANT UPDATE (status, updated_at) ON cards_inventory TO bot_runtime;
CREATE POLICY bot_store_isolation ON cards_inventory TO bot_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- Clientes: acha o visitante pelo telefone e cria um novo no primeiro lance (ADR 0005). Sem CPF,
-- e-mail, endereço nem motivo de blacklist, e sem editar nome ou blacklist.
GRANT SELECT (id, store_id, phone, name, is_visitor, is_blacklisted, last_interaction_at)
  ON customers TO bot_runtime;
GRANT INSERT (store_id, phone, name) ON customers TO bot_runtime;
GRANT UPDATE (last_interaction_at) ON customers TO bot_runtime;
CREATE POLICY bot_store_isolation ON customers TO bot_runtime
  USING (store_id = app_current_store()) WITH CHECK (store_id = app_current_store());

-- Catálogo (global): nome, número, coleção e a imagem (dentro de raw_data).
GRANT SELECT (id, name, card_number, set_name, set_id, raw_data) ON tcgdex_catalog TO bot_runtime;

-- A regra de lance e a virada de estado moram no banco (ADR 0016).
GRANT EXECUTE ON FUNCTION place_bid(uuid, uuid, uuid, numeric, text, timestamptz) TO bot_runtime;
GRANT EXECUTE ON FUNCTION advance_auctions(uuid, timestamptz) TO bot_runtime;

-- Estado da conexão do WhatsApp da loja do contexto (e, ao criar o grupo, o id dele). É SECURITY
-- DEFINER para o bot não precisar de UPDATE em `stores`. Só mexe nas duas colunas e só na loja do
-- contexto (`app.store_id`); id de grupo fora do formato do WhatsApp é recusado.
CREATE FUNCTION bot_set_whatsapp_status(
  p_store_id uuid,
  p_status whatsapp_status,
  p_group_id text DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
BEGIN
  IF p_store_id IS NULL OR p_store_id IS DISTINCT FROM public.app_current_store() THEN
    RETURN false;
  END IF;
  IF p_group_id IS NOT NULL AND p_group_id !~ '^[0-9]{5,30}(-[0-9]{5,30})?@g\.us$' THEN
    RETURN false;
  END IF;
  UPDATE public.stores s
     SET whatsapp_status = p_status,
         whatsapp_group_id = coalesce(p_group_id, s.whatsapp_group_id)
   WHERE s.id = p_store_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION bot_set_whatsapp_status(uuid, whatsapp_status, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bot_set_whatsapp_status(uuid, whatsapp_status, text) TO bot_runtime;
