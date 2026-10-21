-- 0026_cliente-anonimizado: anonimização de cliente e visitante (LGPD mínima, ADR 0019; Backend#43).
-- A linha do cliente fica (o histórico de leilões, lances e acertos continua somável), mas sem dado
-- pessoal; `anonymized_at` marca quando. Anonimizado fica na blacklist: o `place_bid` já recusa lance.
ALTER TABLE customers ADD COLUMN anonymized_at timestamptz;

ALTER TABLE customers
  ADD CONSTRAINT customers_anonymized_requires_blacklist
    CHECK (anonymized_at IS NULL OR is_blacklisted);

-- A anonimização apaga o IP do consentimento (dado pessoal). Só essa coluna, só UPDATE: o papel da API
-- continua sem apagar nem reescrever o resto do registro de consentimento. A política de RLS
-- `store_isolation` (ALL) já cobre o UPDATE dentro da loja do contexto; nenhuma política muda.
GRANT UPDATE (ip) ON lgpd_consents TO app_runtime;
