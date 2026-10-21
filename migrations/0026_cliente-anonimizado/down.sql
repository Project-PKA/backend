-- 0026_cliente-anonimizado: reverte. A marca de anonimização se perde; o dado pessoal já apagado NÃO volta.
REVOKE UPDATE (ip) ON lgpd_consents FROM app_runtime;
ALTER TABLE customers DROP CONSTRAINT customers_anonymized_requires_blacklist;
ALTER TABLE customers DROP COLUMN anonymized_at;
