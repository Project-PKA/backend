-- 0015_paginas-publicas: reverte.
DROP FUNCTION public_consignor_view(text, text, text);
DROP FUNCTION public_settlement_submit(text, text, text, text, text, text, text, text, text, boolean, text);
DROP FUNCTION public_settlement_view(text, text);
DROP FUNCTION public_resolve_link(text, public_link_kind, text);
DROP FUNCTION public_register_failure(text);
DROP FUNCTION public_ip_blocked(text);
DROP FUNCTION public_hash(text);
DROP TABLE public_ip_failures;
DROP TABLE lgpd_consents;
DROP TABLE public_links;
DROP TYPE public_link_kind;
ALTER TABLE stores DROP CONSTRAINT stores_pix_key_length, DROP COLUMN pix_key;
-- O papel é do cluster inteiro (como o app_runtime): sai só a permissão de uso.
REVOKE public_runtime FROM app_runtime;
REVOKE USAGE ON SCHEMA public FROM public_runtime;
