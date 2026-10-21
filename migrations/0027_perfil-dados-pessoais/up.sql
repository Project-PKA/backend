-- 0027_perfil-dados-pessoais: dados pessoais do usuário no perfil (Backend#105). O dono decidiu guardar o
-- CPF do usuário, cifrado como o do cliente (ADR 0019): `cpf` é o texto cifrado (`v1.<iv>.<tag>.<texto>`),
-- `cpf_last2` só dá a máscara. Sem `cpf_key_hash`: o usuário não tem chave de consignador.
-- Só colunas novas e nulas; nada é reescrito. `users` fica fora do RLS (ADR 0011) e só a própria pessoa
-- lê e edita esses campos, pela API.
ALTER TABLE users
  ADD COLUMN phone text,
  ADD COLUMN birth_date date,
  ADD COLUMN cpf text,
  ADD COLUMN cpf_last2 text,
  ADD COLUMN address_zip text,
  ADD COLUMN address_street text,
  ADD COLUMN address_number text,
  ADD COLUMN address_comp text,
  ADD COLUMN address_neighborhood text,
  ADD COLUMN address_city text,
  ADD COLUMN address_state text;

ALTER TABLE users
  ADD CONSTRAINT users_cpf_last2_format CHECK (cpf_last2 IS NULL OR cpf_last2 ~ '^[0-9]{2}$'),
  ADD CONSTRAINT users_cpf_has_last2 CHECK (cpf IS NULL OR cpf_last2 IS NOT NULL),
  ADD CONSTRAINT users_cpf_sealed CHECK (cpf IS NULL OR cpf ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  ADD CONSTRAINT users_address_state_uf CHECK (address_state IS NULL OR address_state ~ '^[A-Z]{2}$');
