-- =============================================================================
-- 0013_autonomy — Module 10: Earned Autonomy, Contention Control & Enterprise (docs/module10.md)
--
-- Two state machines, enforced where the work actually happens (the executor, never the UI):
--   §3  the autonomy ladder — a tier per (workflow × action type), promoted only by a signed
--       certification report and a human's explicit ratification; demoted automatically and
--       instantly on any of §6's triggers, with no "restore" path (only re-certification)
--   §9  contention control — advisory locks on business entities (not rows), a cross-run contact
--       ledger that makes duplicate outreach impossible to miss, and write conflicts surfaced for
--       a human rather than resolved by last-write-wins
--
-- `workflow_key` is the agent's id (text form): this codebase has no separate "objective
-- template" entity, and an agent IS the versioned, certifiable unit the spec describes (§11:
-- "changing one resets certification" — exactly agent_versions already tracks).
-- =============================================================================

-- ============ 10A — Earned Autonomy (D2) ============

CREATE TABLE autonomy_state (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_key      text        NOT NULL,
  action_type       text        NOT NULL,
  tier              text        NOT NULL CHECK (tier IN ('SHADOW','SUPERVISED','SAMPLED','AUTONOMOUS','SUSPENDED')),
  sample_rate       integer     CHECK (sample_rate IS NULL OR sample_rate >= 1),
  since             timestamptz NOT NULL DEFAULT now(),
  certification_id  uuid,
  ratified_by       uuid REFERENCES users(id),
  next_review_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, workflow_key, action_type)
);

CREATE TABLE certifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_key        text        NOT NULL,
  action_type         text        NOT NULL,
  window_from         timestamptz NOT NULL,
  window_to           timestamptz NOT NULL,
  sample_size         integer     NOT NULL,
  agreement_rate      numeric     NOT NULL,
  edit_rate           numeric     NOT NULL,
  critical_errors     integer     NOT NULL,
  error_taxonomy      jsonb       NOT NULL,
  connector_versions  jsonb       NOT NULL,
  model_versions      jsonb       NOT NULL,
  from_tier           text        NOT NULL,
  recommendation      text        NOT NULL CHECK (recommendation IN ('PROMOTE','HOLD','DEMOTE')),
  recommended_tier    text,
  gate_json           jsonb       NOT NULL DEFAULT '{}',          -- every gate condition, pass/fail
  report_ref          text        NOT NULL,                       -- content digest of the rendered report
  signature           text        NOT NULL,                       -- the evidence chain entry's signature
  decided_by          uuid REFERENCES users(id),
  decided_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX certifications_lookup_idx ON certifications (tenant_id, workflow_key, action_type, created_at DESC);

ALTER TABLE autonomy_state ADD CONSTRAINT autonomy_state_certification_fk
  FOREIGN KEY (certification_id) REFERENCES certifications(id);

CREATE TABLE autonomy_transitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_key  text        NOT NULL,
  action_type   text        NOT NULL,
  from_tier     text        NOT NULL,
  to_tier       text        NOT NULL,
  direction     text        NOT NULL CHECK (direction IN ('PROMOTE','DEMOTE')),
  trigger       text        NOT NULL CHECK (trigger IN (
                  'certification','critical_error','error_rate','comp_failure','taint_violation',
                  'novelty','version_change','volume_spike','manual'
                )),
  evidence_json jsonb       NOT NULL,
  actor_id      uuid,                                             -- null: automatic
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX autonomy_transitions_idx ON autonomy_transitions (tenant_id, workflow_key, action_type, created_at DESC);

CREATE TABLE policy_proposals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            text        NOT NULL CHECK (kind IN ('promote','demote','new_policy','tune_weights')),
  subject_json    jsonb       NOT NULL,
  evidence_json   jsonb       NOT NULL,
  proposed_change jsonb       NOT NULL,
  confidence      numeric     NOT NULL,
  state           text        NOT NULL DEFAULT 'open' CHECK (state IN ('open','accepted','dismissed','expired')),
  decided_by      uuid REFERENCES users(id),
  decided_at      timestamptz,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX policy_proposals_idx ON policy_proposals (tenant_id, state, created_at DESC);

CREATE TABLE novelty_baselines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workflow_key  text        NOT NULL,
  action_type   text        NOT NULL,
  feature_stats jsonb       NOT NULL,
  computed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX novelty_baselines_idx ON novelty_baselines (tenant_id, workflow_key, action_type, computed_at DESC);

-- ============ 10B — Contention Control (D6) ============

CREATE TABLE entity_locks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_key       text        NOT NULL,
  mode             text        NOT NULL CHECK (mode IN ('SHARED_READ','EXCLUSIVE_WRITE','COMMUNICATION')),
  holder_run_id    uuid        NOT NULL,
  holder_agent_id  uuid        NOT NULL,
  intent           text        NOT NULL,
  risk_tier        text,                                          -- for deterministic victim selection on a cycle
  acquired_at      timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX entity_locks_exclusive_idx ON entity_locks (tenant_id, entity_key, mode)
  WHERE mode IN ('EXCLUSIVE_WRITE','COMMUNICATION');
CREATE INDEX entity_locks_entity_idx ON entity_locks (tenant_id, entity_key);
CREATE INDEX entity_locks_run_idx ON entity_locks (tenant_id, holder_run_id);

-- A run blocked on a held lock records itself here, which is what makes a two-run wait cycle
-- (R1 holds A, wants B; R2 holds B, wants A) OBSERVABLE: neither acquire() call blocks the
-- connection, each returns immediately, and a cycle is detected and broken (§10.1) the next time
-- either side is retried — bounded by sweeping expired waiters on every acquisition attempt.
CREATE TABLE entity_lock_waits (
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_key      text        NOT NULL,
  mode            text        NOT NULL,
  waiting_run_id  uuid        NOT NULL,
  waiting_agent_id uuid       NOT NULL,
  risk_tier       text,
  waiting_since   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, entity_key, mode, waiting_run_id)
);
CREATE INDEX entity_lock_waits_run_idx ON entity_lock_waits (tenant_id, waiting_run_id);

CREATE TABLE contact_ledger (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  external_identity text        NOT NULL,
  channel           text        NOT NULL CHECK (channel IN ('email','slack','calendar')),
  contacted_at      timestamptz NOT NULL,
  by_run_id         uuid        NOT NULL,
  by_agent_id       uuid        NOT NULL,
  on_behalf_of      uuid        NOT NULL,
  relationship_type text,
  cooldown_until    timestamptz NOT NULL,
  override_reason   text,                                         -- set only when an override bypassed an active cooldown
  overridden_by     uuid
);
CREATE INDEX contact_ledger_identity_idx ON contact_ledger (tenant_id, external_identity, contacted_at DESC);

CREATE TABLE write_conflicts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_key    text        NOT NULL,
  field         text        NOT NULL,
  proposals     jsonb       NOT NULL,
  resolution    text        CHECK (resolution IS NULL OR resolution IN ('merged','escalated','deferred')),
  resolved_by   uuid,
  closed_at     timestamptz,                                       -- the write committed, or a person decided
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX write_conflicts_idx ON write_conflicts (tenant_id, entity_key, created_at DESC);

-- ============ P5 — Budget caps (one row per tenant; a workspace/agent scope is future work) ============

CREATE TABLE budgets (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  limit_cents      integer     NOT NULL DEFAULT 0,
  breach_behavior  text        NOT NULL DEFAULT 'queue' CHECK (breach_behavior IN ('degrade','queue','halt')),
  updated_by       uuid,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ============ Row-level security ============
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'autonomy_state','certifications','autonomy_transitions','policy_proposals','novelty_baselines',
    'entity_locks','entity_lock_waits','contact_ledger','write_conflicts','budgets'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

-- Mutable (ratification, heartbeats, releases, resolutions, proposal decisions, budget edits):
GRANT SELECT, INSERT, UPDATE, DELETE ON autonomy_state, certifications, entity_locks, entity_lock_waits, write_conflicts, policy_proposals, novelty_baselines TO vega_app;
GRANT SELECT, INSERT, UPDATE ON budgets TO vega_app;
-- Append-only history: nobody edits what happened.
REVOKE UPDATE, DELETE, TRUNCATE ON autonomy_transitions, contact_ledger FROM vega_app;
GRANT SELECT, INSERT ON autonomy_transitions, contact_ledger TO vega_app;
