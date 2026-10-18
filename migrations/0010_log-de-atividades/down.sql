-- 0010_log-de-atividades: reverte.
DROP POLICY activity_log_select ON activity_log;
DROP POLICY activity_log_insert ON activity_log;
DROP TABLE activity_log;
