-- =============================================================================
-- 0004_connectors — Module 2 (docs/module2.md §4)
--
-- connectors         a tenant's authorized connection to a provider account
-- tool_declarations  queryable projection of the TypeScript declarations (GLOBAL: identical
--                    for every tenant, generated from code, never hand-edited)
-- tool_invocations   idempotency ledger: a KEYED tool runs at most once per key
-- connector_events   auth refreshes, rate limits, errors, revocations
-- =============================================================================

CREATE TABLE connectors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id    uuid,
  kind            text        NOT NULL,
  display_name    text        NOT NULL,
  -- Provider account identifier (mailbox address, workspace id). Filled on first authorization.
  account_ref     text,
  owner_user_id   uuid        NOT NULL,
  -- What the provider actually granted, and what we asked for. They can differ: the consent
  -- screen shows `scopes_required`, and a tool is usable only if its scopes ⊆ `scopes_granted`.
  scopes_granted  text[]      NOT NULL DEFAULT '{}',
  scopes_required text[]      NOT NULL DEFAULT '{}',
  enabled_tools   text[]      NOT NULL DEFAULT '{}',
  config          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  secret_ref_id   uuid,
  status          text        NOT NULL DEFAULT 'pending',
  health_json     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  last_ok_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT connectors_kind_check
    CHECK (kind IN ('gmail','gcal','gdrive','outlook','sharepoint','slack','web','http','mcp')),
  CONSTRAINT connectors_status_check
    CHECK (status IN ('pending','active','degraded','expired','revoked')),
  CONSTRAINT connectors_owner_fk
    FOREIGN KEY (owner_user_id, tenant_id) REFERENCES users (id, tenant_id),
  CONSTRAINT connectors_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id) ON DELETE CASCADE
);
-- One connection per provider account per kind — but only once the account is known.
CREATE UNIQUE INDEX connectors_account_unique ON connectors (tenant_id, kind, account_ref)
  WHERE account_ref IS NOT NULL;
CREATE INDEX connectors_tenant_idx ON connectors (tenant_id);

-- secret_refs must belong to the same tenant as the connector pointing at it.
ALTER TABLE secret_refs ADD CONSTRAINT secret_refs_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE connectors ADD CONSTRAINT connectors_secret_fk
  FOREIGN KEY (secret_ref_id, tenant_id) REFERENCES secret_refs (id, tenant_id);

-- ============================ tool declarations (GLOBAL) =====================
CREATE TABLE tool_declarations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_kind     text        NOT NULL,
  tool_id            text        NOT NULL,
  version            integer     NOT NULL,
  title              text        NOT NULL,
  description        text        NOT NULL,
  scopes             text[]      NOT NULL,
  egress_class       text        NOT NULL CHECK (egress_class IN ('INTERNAL','EXTERNAL','PUBLIC')),
  reversibility      text        NOT NULL CHECK (reversibility IN ('R0','R1','R2','R3')),
  max_taint          text        NOT NULL CHECK (max_taint IN ('TRUSTED','ORG','UNTRUSTED')),
  output_taint       text        NOT NULL CHECK (output_taint IN ('TRUSTED','ORG','UNTRUSTED')),
  idempotency        text        NOT NULL CHECK (idempotency IN ('NATIVE','KEYED','NONE')),
  sensitivity_hint   integer     NOT NULL DEFAULT 0 CHECK (sensitivity_hint BETWEEN 0 AND 100),
  hold_supported     boolean     NOT NULL DEFAULT false,
  simulate_fidelity  text        NOT NULL CHECK (simulate_fidelity IN ('PROVIDER','DERIVED','DECLARED')),
  compensator_ref    text,
  recipient_args     text[]      NOT NULL DEFAULT '{}',
  args_schema        jsonb       NOT NULL,
  effect_schema      jsonb       NOT NULL,
  cost_hint          jsonb,
  certified_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_kind, tool_id, version),
  -- INVARIANT 4, second line of defence (the type system is the first):
  CONSTRAINT compensator_required
    CHECK (reversibility IN ('R0','R3') OR compensator_ref IS NOT NULL),
  CONSTRAINT no_compensator_for_r0_r3
    CHECK (reversibility IN ('R1','R2') OR compensator_ref IS NULL)
);

-- ============================ invocations =====================================
CREATE TABLE tool_invocations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id    uuid        NOT NULL,
  tool_id         text        NOT NULL,
  idempotency_key text        NOT NULL,
  args_digest     text        NOT NULL,
  state           text        NOT NULL DEFAULT 'in_flight',
  response_ref    text,
  -- The effect a replayed call returns, so "same key" means "same answer", not just "no-op".
  effect_json     jsonb,
  error_code      text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  CONSTRAINT tool_invocations_state_check CHECK (state IN ('in_flight','succeeded','failed')),
  CONSTRAINT tool_invocations_connector_fk
    FOREIGN KEY (connector_id) REFERENCES connectors (id) ON DELETE CASCADE,
  UNIQUE (tenant_id, tool_id, idempotency_key)
);
CREATE INDEX tool_invocations_tenant_idx ON tool_invocations (tenant_id, started_at DESC);

CREATE TABLE connector_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid        NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  kind         text        NOT NULL,
  detail       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connector_events_connector_idx ON connector_events (tenant_id, connector_id, created_at DESC);

-- ============================ RLS ==============================================
ALTER TABLE connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE connectors FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connectors
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE tool_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tool_invocations
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

ALTER TABLE connector_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE connector_events FORCE  ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_events
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());

-- Global reference data, like plan_entitlements: readable by all, written only by migrations.
ALTER TABLE tool_declarations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_declarations FORCE  ROW LEVEL SECURITY;
CREATE POLICY read_all ON tool_declarations FOR SELECT USING (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON connectors, tool_invocations, connector_events TO vega_app;
GRANT USAGE, SELECT ON SEQUENCE connector_events_id_seq TO vega_app;
GRANT SELECT ON tool_declarations TO vega_app;
REVOKE INSERT, UPDATE, DELETE ON tool_declarations FROM vega_app;
