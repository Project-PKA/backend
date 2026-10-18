-- 0016_administracao: reverte.
DROP FUNCTION public_access_request_submit(text, text, text, text, text, text);
DROP TABLE access_requests;
DROP TYPE access_request_status;
DROP TABLE admin_activity_log;
ALTER TABLE stores
  DROP CONSTRAINT stores_member_limit_range,
  DROP CONSTRAINT stores_plan_format,
  DROP CONSTRAINT stores_city_length,
  DROP COLUMN member_limit,
  DROP COLUMN plan,
  DROP COLUMN city;
