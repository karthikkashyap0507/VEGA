-- =============================================================================
-- 0011_approvals — Module 8: Approval, Escalation & Action Center (docs/module8.md §4)
--
-- The approval is a ROW, like Module 6's hold: the executor opens it (with the decision packet it
-- rendered and hashed), a person's decision is a compare-and-set on it (control plane, checked at
-- decide time), and the executor's timers escalate or expire it the same way. Whichever commits
-- first is what happened — across restarts, with nothing in flight.
--
-- approval_decisions is THE OVERRIDE CORPUS (PROJECT.md §1.5): append-only, never deleted.
-- =============================================================================

CREATE TABLE approval_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id                uuid        NOT NULL,
  node_id               uuid        NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
  action_id             uuid,
  -- The executor's key for this exact call (v<version>:<callSeq>:<argsDigest>): a decision
  -- names it, so a decision on an earlier plan or an edited call cannot be replayed onto this one.
  approval_key          text        NOT NULL,
  tool_id               text        NOT NULL,
  requester             uuid        NOT NULL,          -- the person the run acts for
  approver_role         text        NOT NULL,
  assigned_to           uuid,
  delegated_from        uuid,
  escalation_level      integer     NOT NULL DEFAULT 0,
  escalate_at           timestamptz,
  packet_json           jsonb       NOT NULL,          -- the rendered packet, exactly as shown
  packet_digest         text        NOT NULL,          -- → the Module 7 receipt's evidence_digest
  risk_tier             text,
  urgency               text        NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal','urgent')),
  batch_id              uuid,
  notified_at           timestamptz,
  requires_dual         boolean     NOT NULL DEFAULT false,
  approvals_required    integer     NOT NULL DEFAULT 1 CHECK (approvals_required BETWEEN 1 AND 2),
  separation_of_duties  boolean     NOT NULL DEFAULT false,
  approved_by           uuid[]      NOT NULL DEFAULT '{}',
  expires_at            timestamptz NOT NULL,
  fallback              text        NOT NULL CHECK (fallback IN ('AUTO_REJECT','AUTO_APPROVE','ESCALATE')),
  fallback_role         text,
  question_asked_at     timestamptz,
  -- SHA-256 of the one-tap REJECT capability a push carries (no login: stopping is the safe path).
  reject_token_hash     text,
  -- Approve with edits: the edited arguments and what changed, field by field.
  edited_args           jsonb,
  edit_diff             jsonb,
  state                 text        NOT NULL DEFAULT 'pending'
                        CHECK (state IN ('pending','approved','rejected','expired','escalated','superseded','cancelled')),
  resolution            text,                          -- why it ended: decided | fallback:AUTO_REJECT | …
  resolved_by           text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  resolved_at           timestamptz,
  CONSTRAINT approval_requests_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE,
  -- §12: zero approval requests without an expiry and a declared fallback — by construction.
  CONSTRAINT approval_requests_escalate_role CHECK (fallback <> 'ESCALATE' OR fallback_role IS NOT NULL)
);
CREATE UNIQUE INDEX approval_requests_key_unique ON approval_requests (run_id, approval_key) WHERE state IN ('pending');
CREATE INDEX approval_requests_assigned_idx ON approval_requests (assigned_to, state, expires_at);
CREATE INDEX approval_requests_state_idx ON approval_requests (tenant_id, state, created_at DESC);
CREATE UNIQUE INDEX approval_requests_token_unique ON approval_requests (reject_token_hash) WHERE reject_token_hash IS NOT NULL;

-- ============ THE OVERRIDE CORPUS (§5.5): never updated, never deleted ============
CREATE TABLE approval_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id        uuid        NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  run_id            uuid        NOT NULL,
  action_id         uuid,
  tool_id           text        NOT NULL,
  approver_id       uuid,                              -- null only for a system fallback
  approver_role     text,
  decision          text        NOT NULL CHECK (decision IN ('approve','approve_with_edits','reject','question','expired','escalated')),
  reason            text,
  edited            boolean     NOT NULL DEFAULT false,
  edit_diff_json    jsonb,                             -- WHAT changed: [{ path, before, after }], never a rendered string
  latency_ms        integer     NOT NULL CHECK (latency_ms >= 0),
  evidence_opened   boolean     NOT NULL,
  evidence_dwell_ms integer,
  surface           text        NOT NULL CHECK (surface IN ('web','mobile','email','push','system')),
  packet_digest     text        NOT NULL,
  packet_chars      integer     NOT NULL,              -- how much there was to read (rubber-stamp plausibility)
  risk_tier         text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_decisions_approver_idx ON approval_decisions (tenant_id, approver_id, created_at DESC);
CREATE INDEX approval_decisions_request_idx ON approval_decisions (request_id);

-- ============ What was opened, and for how long (instrumented evidence, §6.2) ============
CREATE TABLE approval_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  request_id  uuid        NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  kind        text        NOT NULL CHECK (kind IN ('packet','evidence')),
  dwell_ms    integer     CHECK (dwell_ms >= 0),
  surface     text        NOT NULL DEFAULT 'web',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX approval_views_request_idx ON approval_views (request_id, user_id, kind);

-- ============ Batching & the notification budget (§5.3) ============
CREATE TABLE approval_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id      uuid        NOT NULL,
  scheduled_at timestamptz NOT NULL,
  delivered_at timestamptz,
  item_count   integer     NOT NULL DEFAULT 0,
  state        text        NOT NULL DEFAULT 'accumulating' CHECK (state IN ('accumulating','delivered')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX approval_batches_open_unique ON approval_batches (tenant_id, user_id, scheduled_at) WHERE state = 'accumulating';
CREATE INDEX approval_batches_due_idx ON approval_batches (state, scheduled_at) WHERE state = 'accumulating';

CREATE TABLE notification_budget (
  tenant_id   uuid    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid    NOT NULL,
  day         date    NOT NULL,
  sent        integer NOT NULL DEFAULT 0,
  budget      integer NOT NULL DEFAULT 12,
  overflow    integer NOT NULL DEFAULT 0,          -- notifications the budget held back: a product bug to fix
  PRIMARY KEY (tenant_id, user_id, day)
);

-- ============ Delegation (§5.4): time-bounded, audited, never more than you hold ============
CREATE TABLE delegations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  from_user   uuid        NOT NULL,
  to_user     uuid        NOT NULL,
  role_scope  text,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  reason      text,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT delegations_from_fk FOREIGN KEY (from_user, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT delegations_to_fk FOREIGN KEY (to_user, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT delegations_window CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '90 days'),
  CONSTRAINT delegations_not_self CHECK (from_user <> to_user)
);
CREATE INDEX delegations_active_idx ON delegations (tenant_id, from_user, starts_at, ends_at);

-- ============ Rubber-stamp monitoring (T12, §5.6) ============
CREATE TABLE approval_quality (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  approver_id        uuid        NOT NULL,
  window_start       date        NOT NULL,
  decisions          integer     NOT NULL,
  median_latency_ms  integer     NOT NULL,
  p10_latency_ms     integer     NOT NULL,
  evidence_open_rate numeric     NOT NULL,
  high_evidence_open_rate numeric,
  edit_rate          numeric     NOT NULL,
  reject_rate        numeric     NOT NULL,
  too_fast_rate      numeric     NOT NULL,
  flag               text        CHECK (flag IN ('IMPLAUSIBLE_SPEED','NO_EVIDENCE_REVIEW')),
  computed_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, approver_id, window_start)
);

-- ============ Device authentication for approving from a phone (§6.3: biometric) ============
CREATE TABLE webauthn_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id        uuid        NOT NULL,
  credential_id  text        NOT NULL,
  public_key     text        NOT NULL,             -- COSE, base64url
  counter        bigint      NOT NULL DEFAULT 0,
  transports     text[]      NOT NULL DEFAULT '{}',
  label          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  CONSTRAINT webauthn_user_fk FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX webauthn_credentials_id_unique ON webauthn_credentials (tenant_id, credential_id);

CREATE TABLE webauthn_challenges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  purpose     text        NOT NULL CHECK (purpose IN ('register','approve')),
  challenge   text        NOT NULL,
  request_id  uuid,                                -- approve: bound to exactly one approval
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============ Row-level security ============
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['approval_requests','approval_decisions','approval_views','approval_batches','notification_budget','delegations','approval_quality','webauthn_credentials','webauthn_challenges'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON approval_requests, approval_batches, notification_budget, delegations, approval_quality, webauthn_credentials, webauthn_challenges TO vega_app;
-- The corpus and the view log are records: written once, never rewritten.
REVOKE UPDATE, DELETE, TRUNCATE ON approval_decisions, approval_views FROM vega_app;
GRANT SELECT, INSERT ON approval_decisions, approval_views TO vega_app;

CREATE OR REPLACE FUNCTION approval_corpus_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'approval_decisions is the override corpus: % is forbidden', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER approval_decisions_append_only BEFORE UPDATE OR DELETE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION approval_corpus_append_only();

-- ============ Cross-tenant work discovery for the dispatcher (the vega_sched pattern, 0007) ============
-- Ids and times only; everything else is read under withTenant() like any request.
CREATE FUNCTION sched_approvals_undispatched(p_limit integer)
  RETURNS TABLE (tenant_id uuid, request_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT r.tenant_id, r.id FROM approval_requests r
   WHERE r.state = 'pending' AND r.notified_at IS NULL AND r.batch_id IS NULL
   ORDER BY r.created_at LIMIT least(p_limit, 500)
$$;

CREATE FUNCTION sched_approval_batches_due(p_now timestamptz)
  RETURNS TABLE (tenant_id uuid, batch_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT b.tenant_id, b.id FROM approval_batches b WHERE b.state = 'accumulating' AND b.scheduled_at <= p_now
$$;

CREATE FUNCTION sched_approval_tenants()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT d.tenant_id FROM approval_decisions d WHERE d.created_at > now() - interval '30 days'
$$;

CREATE POLICY sched_read ON approval_requests  FOR SELECT TO vega_sched USING (true);
CREATE POLICY sched_read ON approval_batches   FOR SELECT TO vega_sched USING (true);
CREATE POLICY sched_read ON approval_decisions FOR SELECT TO vega_sched USING (true);
GRANT SELECT (id, tenant_id, state, notified_at, batch_id, created_at) ON approval_requests TO vega_sched;
GRANT SELECT (id, tenant_id, state, scheduled_at) ON approval_batches TO vega_sched;
GRANT SELECT (tenant_id, created_at) ON approval_decisions TO vega_sched;
ALTER FUNCTION sched_approvals_undispatched(integer) OWNER TO vega_sched;
ALTER FUNCTION sched_approval_batches_due(timestamptz) OWNER TO vega_sched;
ALTER FUNCTION sched_approval_tenants() OWNER TO vega_sched;
REVOKE ALL ON FUNCTION sched_approvals_undispatched(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION sched_approval_batches_due(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION sched_approval_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sched_approvals_undispatched(integer) TO vega_app;
GRANT EXECUTE ON FUNCTION sched_approval_batches_due(timestamptz) TO vega_app;
GRANT EXECUTE ON FUNCTION sched_approval_tenants() TO vega_app;

-- One-tap reject from a push (no session): the capability's hash → its tenant and request.
CREATE FUNCTION approval_by_reject_token(p_hash text)
  RETURNS TABLE (tenant_id uuid, request_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT r.tenant_id, r.id FROM approval_requests r WHERE r.reject_token_hash = p_hash AND r.state = 'pending'
$$;
GRANT SELECT (reject_token_hash) ON approval_requests TO vega_sched;
ALTER FUNCTION approval_by_reject_token(text) OWNER TO vega_sched;
REVOKE ALL ON FUNCTION approval_by_reject_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION approval_by_reject_token(text) TO vega_app;
