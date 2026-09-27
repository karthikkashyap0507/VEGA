-- =============================================================================
-- 0009_reversibility — Module 6 (docs/module6.md §4): compensations, holds, blast-radius
-- snapshots, divergences, Time-to-Undo measurements — plus two tables the spec implies:
-- incidents (a failed compensation is a first-class incident, §5.3) and rollbacks (one row per
-- undo request, whose compensations run in strict reverse order of commitment, §5.8).
--
-- The execution plane writes these (it captures before the call, runs the compensators, holds
-- the timers); the control plane reads them for the console and commits the user's revoke /
-- release / edit decisions on `holds` (a compare-and-set on `state` is the arbiter between a
-- revoke and the timer, §5.5 "restart safety").
-- =============================================================================

-- Order of commitment across a run's program versions: a saga compensates in DESCENDING order.
CREATE SEQUENCE compensation_commit_seq;

-- ============ Rollbacks: one undo request (a single action, a whole run, or a saga) ============
CREATE TABLE rollbacks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id           uuid        NOT NULL,
  scope            text        NOT NULL CHECK (scope IN ('action','run')),
  -- user: someone pressed Undo · run_failure/divergence/verification: the saga (§5.7, §5.8)
  trigger          text        NOT NULL CHECK (trigger IN ('user','run_failure','divergence','verification')),
  requested_by     uuid,
  -- "user decides to undo" (the click, or the automatic failure detection): Time-to-Undo's start.
  requested_at     timestamptz NOT NULL DEFAULT now(),
  state            text        NOT NULL DEFAULT 'running' CHECK (state IN ('running','succeeded','failed','nothing_to_undo')),
  -- In execution order (reverse commitment).
  compensation_ids uuid[]      NOT NULL DEFAULT '{}',
  finished_at      timestamptz,
  summary_json     jsonb,
  CONSTRAINT rollbacks_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT rollbacks_requester_fk FOREIGN KEY (requested_by, tenant_id) REFERENCES users (id, tenant_id)
);
CREATE INDEX rollbacks_run_idx ON rollbacks (tenant_id, run_id, requested_at DESC);

-- ============ Compensations: captured BEFORE the forward call (§5.2) ============
CREATE TABLE compensations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id        uuid        REFERENCES actions(id) ON DELETE CASCADE,
  run_id           uuid        NOT NULL,
  node_id          uuid        NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
  connector_id     uuid        NOT NULL,
  tool_id          text        NOT NULL,
  compensator_ref  text        NOT NULL,
  -- The CompensationToken (pre-state snapshots can hold message and event content): envelope-
  -- encrypted like connector credentials; never returned by an API, only described.
  token_sealed     jsonb       NOT NULL,
  token_digest     text        NOT NULL,
  confidence       text        NOT NULL CHECK (confidence IN ('EXACT','APPROXIMATE')),
  side_effects     text        NOT NULL CHECK (side_effects IN ('SILENT','NOTIFIES_THIRD_PARTY')),
  -- The consequence of undoing, in plain words, shown before anyone commits to it (§6.3).
  description      text        NOT NULL,
  ttl_ms           bigint      NOT NULL CHECK (ttl_ms > 0),
  -- What the forward call did: pending until it returns; only committed/unknown can be undone.
  forward_state    text        NOT NULL DEFAULT 'pending' CHECK (forward_state IN ('pending','committed','failed','unknown')),
  commit_seq       bigint,
  committed_at     timestamptz,
  -- After this the action is permanent and the UI says so (§5.3 "compensators expire").
  ttl_at           timestamptz,
  state            text        NOT NULL DEFAULT 'armed' CHECK (state IN ('armed','executing','succeeded','failed','expired','not_needed')),
  attempts         integer     NOT NULL DEFAULT 0,
  rollback_id      uuid        REFERENCES rollbacks(id) ON DELETE SET NULL,
  executed_at      timestamptz,
  result_json      jsonb,
  last_error       jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compensations_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT compensations_ttl_check CHECK (forward_state NOT IN ('committed','unknown') OR ttl_at IS NOT NULL)
);
-- One compensation per executed call (its journal row). A re-captured call replaces its token.
CREATE UNIQUE INDEX compensations_node_unique ON compensations (node_id);
CREATE INDEX compensations_run_idx ON compensations (tenant_id, run_id, commit_seq DESC);
CREATE INDEX compensations_armed_ttl_idx ON compensations (state, ttl_at) WHERE state = 'armed';

-- ============ Holds: a revocable delay before an R2 action is released (§5.5) ============
CREATE TABLE holds (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id           uuid        REFERENCES actions(id) ON DELETE CASCADE,
  run_id              uuid        NOT NULL,
  node_id             uuid        NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
  -- The executor's key for this exact call (v<version>:<callSeq>:<argsDigest>, "~e<n>" once edited).
  hold_key            text        NOT NULL,
  tool_id             text        NOT NULL,
  window_ms           integer     NOT NULL CHECK (window_ms >= 0),
  -- The held content (arguments + predicted effect), viewable during the hold by whoever may
  -- revoke it (§10). Stored sealed in the row; artifact_ref names where it lives.
  artifact_ref        text        NOT NULL,
  artifact_sealed     jsonb       NOT NULL,
  expires_at          timestamptz NOT NULL,
  -- Revoke authorization, precomputed when the hold is created (§9 "fast revoke path").
  allowed_revokers    uuid[]      NOT NULL,
  -- SHA-256 of the one-tap revoke capability a push notification carries (no login challenge).
  revoke_token_hash   text,
  released_at         timestamptz,
  released_by         text,
  revoked_at          timestamptz,
  revoked_by          uuid,
  revoke_reason       text,
  revoke_channel      text        CHECK (revoke_channel IN ('app','push')),
  edited              boolean     NOT NULL DEFAULT false,
  -- Override telemetry for Module 10: which fields a person changed, from what to what.
  edit_diff           jsonb,
  edited_args_sealed  jsonb,
  -- When the person's revoke / release / edit arrived (Time-to-Undo's start for a revoke).
  requested_at        timestamptz,
  state               text        NOT NULL DEFAULT 'holding' CHECK (state IN ('holding','released','revoked','edited_requeued','expired_released','expired','needs_attention')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT holds_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT holds_revoker_fk FOREIGN KEY (revoked_by, tenant_id) REFERENCES users (id, tenant_id)
);
CREATE UNIQUE INDEX holds_key_unique ON holds (run_id, hold_key);
CREATE INDEX holds_holding_idx ON holds (state, expires_at) WHERE state = 'holding';
CREATE UNIQUE INDEX holds_token_unique ON holds (revoke_token_hash) WHERE revoke_token_hash IS NOT NULL;

-- ============ Blast radius: the aggregated simulated effect of a program (§5.6) ============
CREATE TABLE blast_radius (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id           uuid        NOT NULL,
  program_version  integer     NOT NULL,
  program_digest   text        NOT NULL,
  effects_json     jsonb       NOT NULL,
  summary_json     jsonb       NOT NULL,
  -- A blast radius is only as trustworthy as its weakest simulation; NONE: nothing consequential.
  min_fidelity     text        NOT NULL CHECK (min_fidelity IN ('PROVIDER','DERIVED','DECLARED','NONE')),
  computed_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT blast_radius_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX blast_radius_run_idx ON blast_radius (tenant_id, run_id, computed_at DESC);

-- ============ Divergences: the simulated effect against the actual one (§5.7) ============
CREATE TABLE divergences (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id        uuid,
  run_id           uuid        NOT NULL,
  node_id          uuid        NOT NULL,
  tool_id          text        NOT NULL,
  simulated_json   jsonb       NOT NULL,
  actual_json      jsonb       NOT NULL,
  diff_json        jsonb       NOT NULL,
  severity         text        NOT NULL CHECK (severity IN ('WITHIN_TOLERANCE','ABORT')),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX divergences_tool_idx ON divergences (tenant_id, tool_id, created_at DESC);

-- ============ Time-to-Undo: from "user decides" to "state restored" (§5.9) ============
CREATE TABLE undo_metrics (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  action_id        uuid,
  run_id           uuid        NOT NULL,
  tool_id          text        NOT NULL,
  kind             text        NOT NULL CHECK (kind IN ('revoke','compensate')),
  channel          text        NOT NULL CHECK (channel IN ('app','push','saga')),
  requested_at     timestamptz NOT NULL,
  restored_at      timestamptz,
  duration_ms      integer     CHECK (duration_ms >= 0),
  succeeded        boolean     NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX undo_metrics_tool_idx ON undo_metrics (tenant_id, tool_id, requested_at DESC);

-- ============ Incidents: never a silent log line (§5.3) ============
CREATE TABLE incidents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind             text        NOT NULL CHECK (kind IN ('compensation_failed','hold_ambiguous','divergence_abort')),
  severity         text        NOT NULL CHECK (severity IN ('HIGH','CRITICAL')),
  title            text        NOT NULL,
  run_id           uuid,
  action_id        uuid,
  compensation_id  uuid,
  -- What failed, the state the world is in now, and the manual remediation steps (§6.4).
  detail_json      jsonb       NOT NULL DEFAULT '{}',
  state            text        NOT NULL DEFAULT 'open' CHECK (state IN ('open','acknowledged','resolved')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  resolved_by      uuid,
  resolved_at      timestamptz,
  resolution       text
);
CREATE INDEX incidents_open_idx ON incidents (tenant_id, state, created_at DESC);

-- ============ Row-level security ============
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rollbacks','compensations','holds','blast_radius','divergences','undo_metrics','incidents'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON rollbacks, compensations, holds, blast_radius, incidents TO vega_app;
-- Divergences and Time-to-Undo measurements are records: written once, never rewritten
-- (0001's default privileges grant full DML on new tables, so the narrowing is explicit).
REVOKE UPDATE, DELETE, TRUNCATE ON divergences, undo_metrics FROM vega_app;
GRANT SELECT, INSERT ON divergences, undo_metrics TO vega_app;
GRANT USAGE ON SEQUENCE compensation_commit_seq TO vega_app;
