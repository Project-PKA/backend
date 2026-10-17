-- 0008_acesso-e-convites: reverte.
ALTER TABLE stores ADD COLUMN whatsapp_session_data text;
UPDATE stores s SET whatsapp_session_data = w.session_data
  FROM whatsapp_sessions w WHERE w.store_id = s.id;
DROP TABLE whatsapp_sessions;

DROP TABLE invitations;

ALTER TABLE refresh_tokens DROP COLUMN ip, DROP COLUMN user_agent;

DROP INDEX users_status_idx;
ALTER TABLE users
  DROP CONSTRAINT users_store_limit_requires_permission,
  DROP CONSTRAINT users_store_limit_nonneg,
  DROP COLUMN last_login_at,
  DROP COLUMN store_limit,
  DROP COLUMN can_create_stores,
  DROP COLUMN is_platform_admin,
  DROP COLUMN status,
  DROP COLUMN name;

DROP TYPE invitation_status;
DROP TYPE user_status;
