-- One-time database setup, run by the `psycrm-bootstrap` ECS task as the RDS master user
-- (psycrm_admin). Safe to run again: it creates what is missing and re-applies the rest.
--
--   psql ... -v mig_pw="$MIG_PW" -v app_pw="$APP_PW" -f roles.sql
--
-- psycrm_migrator owns the schema (only the migration task connects as it).
-- psycrm_app is what the server uses: read/write rows, nothing else. It gets no
-- TRUNCATE and cannot change the schema, which is part of what protects audit_log.

SELECT 'CREATE ROLE psycrm_migrator LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'psycrm_migrator') \gexec
SELECT 'CREATE ROLE psycrm_app LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'psycrm_app') \gexec
ALTER ROLE psycrm_migrator PASSWORD :'mig_pw';
ALTER ROLE psycrm_app PASSWORD :'app_pw';

-- RDS's master user is not a true superuser: it must be a member of a role to configure it.
GRANT psycrm_migrator TO CURRENT_USER;
GRANT psycrm_app TO CURRENT_USER;

REVOKE ALL ON DATABASE psycrm FROM PUBLIC;
GRANT CONNECT ON DATABASE psycrm TO psycrm_migrator, psycrm_app;

-- The migrator owns everything it creates in `public`; the app can only use it.
ALTER SCHEMA public OWNER TO psycrm_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO psycrm_app;

ALTER DEFAULT PRIVILEGES FOR ROLE psycrm_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO psycrm_app;
ALTER DEFAULT PRIVILEGES FOR ROLE psycrm_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO psycrm_app;

-- pg-boss keeps its queues in its own schema and creates its tables on first start.
CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION psycrm_app;
