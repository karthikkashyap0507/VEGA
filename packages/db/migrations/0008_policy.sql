-- =============================================================================
-- 0008_policy — Module 5 (docs/module5.md §4): authored policies, signed bundles, every policy
-- and risk evaluation, versioned risk weights, the classification cache and simulations.
--
-- The policy DECISION is made in the execution plane (the policy hook, packages/policy-engine
-- against OPA); authoring, compilation, simulation, signing and activation are the control
-- plane's. Both write here under withTenant(); OPA itself reads only signed bundles from object
-- storage, never this database.
-- =============================================================================

-- ============ Policies: YAML is the source of truth; Rego is generated ============
CREATE TABLE policies (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key           text        NOT NULL CHECK (key ~ '^[a-z][a-z0-9-]{1,62}$'),
  version       integer     NOT NULL CHECK (version >= 1),
  spec_yaml     text        NOT NULL,
  compiled_rego text        NOT NULL,
  citation      text,
  description   text        NOT NULL,
  severity      text        NOT NULL DEFAULT 'normal' CHECK (severity IN ('low','normal','high','critical')),
  decision      text        NOT NULL CHECK (decision IN ('ALLOW','ALLOW_WITH_HOLD','REQUIRE_APPROVAL','REQUIRE_DUAL_APPROVAL','DENY')),
  author_id     uuid        NOT NULL,
  active_from   timestamptz,
  active_to     timestamptz,
  state         text        NOT NULL DEFAULT 'draft' CHECK (state IN ('draft','simulated','active','retired')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policies_author_fk FOREIGN KEY (author_id, tenant_id) REFERENCES users (id, tenant_id),
  CONSTRAINT policies_id_tenant_key UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, key, version)
);
CREATE INDEX policies_tenant_key_idx ON policies (tenant_id, key, version DESC);

-- ============ Signed bundles shipped to OPA (through object storage) ============
CREATE TABLE policy_bundles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version         integer     NOT NULL CHECK (version >= 1),
  policy_ids      uuid[]      NOT NULL,
  -- [{key, version}] in the order compiled: what a reviewer and a simulation read.
  policy_versions jsonb       NOT NULL,
  -- The generated module, kept for inspection; the signed tar in object storage is what OPA loads.
  rego            text        NOT NULL,
  revision        text        NOT NULL,
  bundle_ref      text        NOT NULL,
  digest          text        NOT NULL,
  signature       text        NOT NULL,
  created_by      uuid        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  activated_at    timestamptz,
  activated_by    uuid,
  superseded_at   timestamptz,
  CONSTRAINT policy_bundles_creator_fk FOREIGN KEY (created_by, tenant_id) REFERENCES users (id, tenant_id),
  CONSTRAINT policy_bundles_id_tenant_key UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, version)
);
-- At most one active bundle per tenant: the newest activated and not superseded.
CREATE UNIQUE INDEX policy_bundles_one_active ON policy_bundles (tenant_id) WHERE activated_at IS NOT NULL AND superseded_at IS NULL;

-- ============ Risk weights (data, versioned; never mutated) ============
-- `version` is global (a sequence), so a stored weights_version names exactly one weight set
-- whichever tenant it belongs to. tenant_id NULL = the platform default.
CREATE SEQUENCE risk_weights_version_seq START 2;
CREATE TABLE risk_weights (
  version     integer     PRIMARY KEY DEFAULT nextval('risk_weights_version_seq'),
  tenant_id   uuid        REFERENCES tenants(id) ON DELETE CASCADE,
  weights     jsonb       NOT NULL,
  boundaries  jsonb       NOT NULL,
  active_from timestamptz NOT NULL DEFAULT now(),
  author_id   uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER SEQUENCE risk_weights_version_seq OWNED BY risk_weights.version;
CREATE INDEX risk_weights_tenant_idx ON risk_weights (tenant_id, active_from DESC);
INSERT INTO risk_weights (version, tenant_id, weights, boundaries, active_from)
VALUES (1, NULL, '{"w1":0.3,"w2":0.4,"w3":0.3,"w4":0.35,"w5":0.4,"w6":0.25,"w7":0.2}', '{"low":25,"medium":55,"high":80}', '2026-01-01T00:00:00Z');

-- ============ Risk scores (reproducible from input + weights version) ============
CREATE TABLE risk_evaluations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id          uuid,
  action_id       uuid,
  node_id         uuid,
  score           integer     NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier            text        NOT NULL CHECK (tier IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  weights_version integer     NOT NULL REFERENCES risk_weights(version),
  -- Every input (replay recomputes from these with the RECORDED weights) and every factor.
  input_json      jsonb       NOT NULL,
  factors_json    jsonb       NOT NULL,
  explanation_json jsonb      NOT NULL,
  hard_gate       text,
  hard_gates      text[]      NOT NULL DEFAULT '{}',
  evaluated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX risk_evaluations_run_idx ON risk_evaluations (tenant_id, run_id, node_id);
CREATE INDEX risk_evaluations_time_idx ON risk_evaluations (tenant_id, evaluated_at DESC);

-- ============ Every policy evaluation, recorded ============
CREATE TABLE policy_evaluations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id             uuid        NOT NULL,
  action_id          uuid,
  node_id            uuid        NOT NULL,
  dsl_node_id        text,
  tool_id            text        NOT NULL,
  -- The tenant bundle OPA answered with (0 = none activated) and its loaded revision.
  bundle_version     integer     NOT NULL DEFAULT 0,
  bundle_revision    text,
  preset             text        NOT NULL,
  -- The DECIDING rule: a policy key, or (tier-default) / (hard-gate) / (fail-closed).
  policy_key         text        NOT NULL,
  policy_version     integer     NOT NULL DEFAULT 0,
  decision           text        NOT NULL CHECK (decision IN ('ALLOW','ALLOW_WITH_HOLD','REQUIRE_APPROVAL','REQUIRE_DUAL_APPROVAL','DENY')),
  approver_role      text,
  hold_window_ms     integer,
  reason_json        jsonb       NOT NULL,
  -- The OPA input document and every match: what simulation replays and an audit reads.
  input_json         jsonb       NOT NULL,
  matches_json       jsonb       NOT NULL,
  risk_evaluation_id uuid        REFERENCES risk_evaluations(id) ON DELETE SET NULL,
  fail_closed        boolean     NOT NULL DEFAULT false,
  latency_ms         integer,
  evaluated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policy_evaluations_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX policy_evaluations_run_idx ON policy_evaluations (tenant_id, run_id, node_id);
CREATE INDEX policy_evaluations_time_idx ON policy_evaluations (tenant_id, evaluated_at DESC);

-- ============ Sensitivity classification cache (digests only, never content) ============
CREATE TABLE classifications (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content_digest text        NOT NULL CHECK (content_digest ~ '^sha256:[0-9a-f]{64}$'),
  entities       jsonb       NOT NULL,
  sensitivity    integer     NOT NULL CHECK (sensitivity BETWEEN 0 AND 100),
  labels         text[]      NOT NULL,
  classifier     text        NOT NULL,
  classified_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, content_digest)
);

-- ============ Simulation results: the required gate before activation (§5.8) ============
CREATE TABLE policy_simulations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bundle_id          uuid        NOT NULL,
  baseline_bundle_id uuid,
  window_from        timestamptz NOT NULL,
  window_to          timestamptz NOT NULL,
  actions_replayed   integer     NOT NULL,
  summary_json       jsonb       NOT NULL,
  changes_json       jsonb       NOT NULL,
  run_by             uuid        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT policy_simulations_bundle_fk FOREIGN KEY (bundle_id, tenant_id) REFERENCES policy_bundles (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT policy_simulations_runner_fk FOREIGN KEY (run_by, tenant_id) REFERENCES users (id, tenant_id)
);
CREATE INDEX policy_simulations_bundle_idx ON policy_simulations (tenant_id, bundle_id, created_at DESC);

-- ============ Row-level security ============
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['policies','policy_bundles','risk_evaluations','policy_evaluations','classifications','policy_simulations','risk_weights'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;
-- The platform default weights are readable by every tenant and writable by none: a separate
-- SELECT-only policy, so UPDATE and DELETE still see only the tenant's own rows.
CREATE POLICY global_read ON risk_weights FOR SELECT USING (tenant_id IS NULL);

GRANT SELECT, INSERT, UPDATE ON policies, policy_bundles, policy_simulations, classifications TO vega_app;
-- Evaluations and weight versions are append-only records (an audit reads them; replay depends
-- on them; nothing rewrites one). The schema's default privileges (0001) grant full DML on every
-- new table, so the narrowing is explicit.
REVOKE UPDATE, DELETE, TRUNCATE ON policy_evaluations, risk_evaluations, risk_weights FROM vega_app;
GRANT SELECT, INSERT ON policy_evaluations, risk_evaluations, risk_weights TO vega_app;
GRANT USAGE ON SEQUENCE risk_weights_version_seq TO vega_app;

-- ============ Cross-tenant: the discovery bundle lists every tenant's active bundle ============
-- OPA learns which bundles to load from ONE signed discovery bundle; rebuilding it after an
-- activation needs the active bundle of every tenant — ids and object keys only.
CREATE FUNCTION sched_policy_bundles()
  RETURNS TABLE (tenant_id uuid, version integer, bundle_ref text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT b.tenant_id, b.version, b.bundle_ref FROM policy_bundles b
   WHERE b.activated_at IS NOT NULL AND b.superseded_at IS NULL
   ORDER BY b.tenant_id
$$;
CREATE POLICY sched_read ON policy_bundles FOR SELECT TO vega_sched USING (true);
GRANT SELECT (tenant_id, version, bundle_ref, activated_at, superseded_at) ON policy_bundles TO vega_sched;
ALTER FUNCTION sched_policy_bundles() OWNER TO vega_sched;
REVOKE ALL ON FUNCTION sched_policy_bundles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sched_policy_bundles() TO vega_app;
