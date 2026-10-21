-- 0025_cliente-bairro-blacklist: reverte. Perde o bairro e a data de entrada na blacklist.
ALTER TABLE customers DROP CONSTRAINT customers_blacklisted_at_requires_flag;
ALTER TABLE customers
  DROP COLUMN blacklisted_at,
  DROP COLUMN address_neighborhood;
