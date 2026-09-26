-- Least-privilege application role.
-- RLS is FORCEd on tenant-scoped tables so even the owner is filtered, but the
-- application must still never connect as the owner. See docs/module1.md 4.1.

CREATE ROLE vega_app LOGIN PASSWORD 'vega_app_local_dev_only';

GRANT CONNECT ON DATABASE vega TO vega_app;
GRANT USAGE ON SCHEMA public TO vega_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vega_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vega_app;

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";
