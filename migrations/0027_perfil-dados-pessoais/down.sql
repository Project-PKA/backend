-- 0027_perfil-dados-pessoais: reverte. Perde telefone, nascimento, CPF cifrado e endereço dos usuários.
ALTER TABLE users
  DROP CONSTRAINT users_address_state_uf,
  DROP CONSTRAINT users_cpf_sealed,
  DROP CONSTRAINT users_cpf_has_last2,
  DROP CONSTRAINT users_cpf_last2_format;
ALTER TABLE users
  DROP COLUMN address_state,
  DROP COLUMN address_city,
  DROP COLUMN address_neighborhood,
  DROP COLUMN address_comp,
  DROP COLUMN address_number,
  DROP COLUMN address_street,
  DROP COLUMN address_zip,
  DROP COLUMN cpf_last2,
  DROP COLUMN cpf,
  DROP COLUMN birth_date,
  DROP COLUMN phone;
