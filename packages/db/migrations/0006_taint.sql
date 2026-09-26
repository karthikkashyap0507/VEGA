-- =============================================================================
-- 0006_taint — Module 3 (docs/module3.md §4): provenance and taint.
--
-- sources           every piece of content that entered a run, with its label and digest
-- derivations       the provenance graph: one row per interpreter step, edges in input_refs
-- taint_violations  SECURITY INCIDENTS, not errors (they page, and M8/M10 act on them)
-- programs          the planner's emitted AST, versioned and replayable (M7)
-- trusted_contacts  the `contacts` registry `resolve` may endorse from (admin-managed)
-- =============================================================================

CREATE TABLE sources (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id       text,
  uri          text        NOT NULL,
  connector_id uuid,
  taint        text        NOT NULL CHECK (taint IN ('TRUSTED','ORG','UNTRUSTED')),
  digest       text        NOT NULL,
  content_ref  text,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  meta         jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX sources_run_idx ON sources (tenant_id, run_id);
CREATE INDEX sources_digest_idx ON sources (digest);

CREATE TABLE derivations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        text        NOT NULL,
  value_ref     text        NOT NULL,
  op            text        NOT NULL,
  source_ids    text[]      NOT NULL DEFAULT '{}',
  input_refs    text[]      NOT NULL DEFAULT '{}',
  taint         text        NOT NULL CHECK (taint IN ('TRUSTED','ORG','UNTRUSTED')),
  data_taint    text        NOT NULL CHECK (data_taint IN ('TRUSTED','ORG','UNTRUSTED')),
  context_taint text        NOT NULL CHECK (context_taint IN ('TRUSTED','ORG','UNTRUSTED')),
  node_id       text,
  step_index    integer     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX derivations_run_idx ON derivations (tenant_id, run_id, step_index);

CREATE TABLE taint_violations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id          text        NOT NULL,
  node_id         text,
  tool_id         text        NOT NULL,
  kind            text        NOT NULL CHECK (kind IN ('RECIPIENT','CEILING','PROVENANCE','SCHEMA')),
  attempted_taint text        NOT NULL CHECK (attempted_taint IN ('TRUSTED','ORG','UNTRUSTED')),
  declared_max    text        NOT NULL CHECK (declared_max IN ('TRUSTED','ORG','UNTRUSTED')),
  arg_path        text        NOT NULL,
  source_ids      text[]      NOT NULL DEFAULT '{}',
  program_ref     text        NOT NULL,
  severity        text        NOT NULL CHECK (severity IN ('HIGH','CRITICAL')),
  detail          text        NOT NULL DEFAULT '',
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX taint_violations_tenant_idx ON taint_violations (tenant_id, created_at DESC);

CREATE TABLE programs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id            text        NOT NULL,
  ast_json          jsonb       NOT NULL,
  ast_digest        text        NOT NULL,
  model_id          text        NOT NULL,
  valid             boolean     NOT NULL,
  validation_errors jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX programs_run_idx ON programs (tenant_id, run_id);

CREATE TABLE trusted_contacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email        text        NOT NULL,
  display_name text,
  company      text,
  added_by     uuid        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trusted_contacts_email_check CHECK (email = lower(email) AND email ~ '^[^@\s]+@[^@\s]+$'),
  CONSTRAINT trusted_contacts_added_by_fk FOREIGN KEY (added_by, tenant_id) REFERENCES users (id, tenant_id),
  UNIQUE (tenant_id, email)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sources','derivations','taint_violations','programs','trusted_contacts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON sources, derivations, programs, trusted_contacts TO vega_app;
-- A violation is evidence: the application may record and acknowledge one, never delete it.
GRANT SELECT, INSERT, UPDATE ON taint_violations TO vega_app;
