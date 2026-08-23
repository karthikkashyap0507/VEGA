-- =============================================================================
-- 0001_rls — Row-Level Security
--
-- THE security boundary of Module 1. Read docs/module1.md §4.1 before changing anything here.
--
-- Four things have to be true for RLS to actually protect anything. Getting three of them
-- right produces a system that looks isolated and is not:
--
--   1. ENABLE ROW LEVEL SECURITY        — turns policies on
--   2. FORCE  ROW LEVEL SECURITY        — applies them to the table OWNER too. Without this,
--                                         migrations and any owner-connection bypass silently.
--   3. The application connects as a NON-SUPERUSER role. Superusers bypass RLS even with
--      FORCE. This is why packages/db refuses to start on a superuser connection.
--   4. Policies carry WITH CHECK as well as USING. USING filters reads; without WITH CHECK a
--      tenant can INSERT or UPDATE rows *into another tenant*.
--
-- On the predicate:
--   NULLIF(current_setting('vega.tenant_id', true), '')::uuid
--     · the `true` second argument makes a missing setting return NULL rather than raising
--     · NULLIF maps the empty string to NULL, so a blank setting cannot raise 22P02
--     · NULL compared to tenant_id yields NULL, which filters the row out
--   The result is FAIL-CLOSED: no tenant context means no rows, never all rows.
-- =============================================================================

-- Read once per policy evaluation; STABLE lets the planner cache it per statement.
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT NULLIF(current_setting('vega.tenant_id', true), '')::uuid
$$;

COMMENT ON FUNCTION current_tenant_id() IS
  'Tenant context for RLS. NULL when unset, which filters every row (fail-closed). '
  'Set only via set_config(''vega.tenant_id'', $1, true) inside a transaction — see withTenant().';

-- ============================ tenants ========================================
-- Scoped on `id` rather than `tenant_id`: a tenant may see only its own row.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenants
  USING      (id = current_tenant_id())
  WITH CHECK (id = current_tenant_id());

-- ============================ tenant-scoped tables ===========================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON users
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspaces
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_members
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE secret_refs ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_refs FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON secret_refs
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE platform_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_events
  USING      (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());

-- ============================ plan_entitlements ==============================
-- DELIBERATELY NOT tenant-scoped: global reference data, identical for every tenant.
-- RLS is still enabled so the coverage test does not have to special-case it, with a
-- read-only policy. Writes go through the system connection (migrations/seed).
ALTER TABLE plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_entitlements FORCE  ROW LEVEL SECURITY;
CREATE POLICY read_all ON plan_entitlements FOR SELECT USING (true);

COMMENT ON TABLE plan_entitlements IS
  'GLOBAL reference data — intentionally not tenant-scoped. Tiers are data, not conditionals '
  '(PROJECT.md §22.1, decision D-09). Entitlements gate EXPOSURE, never business logic.';

-- ============================ grants =========================================
-- The application role. Not a superuser, so RLS binds it.
GRANT USAGE ON SCHEMA public TO vega_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vega_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vega_app;

-- plan_entitlements is reference data: the app reads it and never writes it.
REVOKE INSERT, UPDATE, DELETE ON plan_entitlements FROM vega_app;

-- The migration ledger is system-owned; the app has no business reading or writing it.
REVOKE ALL ON _migrations FROM vega_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vega_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vega_app;
