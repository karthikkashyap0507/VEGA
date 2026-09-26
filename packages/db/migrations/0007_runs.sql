-- =============================================================================
-- 0007_runs — Module 4 (docs/module4.md §4): runs, the executable graph, actions, replans,
-- agent versions, conversations and trigger bookkeeping.
--
-- A run is ONE durable workflow (DBOS, packages/orchestration; decision D-13). task_nodes is
-- both the plan (rows written at PLAN time with pre-annotations, call_seq NULL) and the
-- execution journal (the first invocation of a planned call claims its row by setting call_seq,
-- the Nth invocation of that program version). The journal is what makes replay deterministic
-- and effects at-most-once.
-- =============================================================================

ALTER TABLE agents ADD CONSTRAINT agents_id_tenant_key UNIQUE (id, tenant_id);
-- A webhook trigger authenticates with a per-agent secret; only its hash is stored.
ALTER TABLE agents ADD COLUMN webhook_secret_hash text;

-- Programs of a durable run are versioned: v1 is the first plan, each replan adds one. The
-- digest and pinned model id are already here (M3); `source` says who wrote it.
ALTER TABLE programs ADD COLUMN version integer;
ALTER TABLE programs ADD COLUMN source text;
ALTER TABLE programs ADD COLUMN attempts integer;
ALTER TABLE programs ADD CONSTRAINT programs_source_check CHECK (source IS NULL OR source IN ('planner','spec','dev_planner'));

CREATE TABLE runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id      uuid        NOT NULL,
  agent_id          uuid        NOT NULL,
  agent_version     integer     NOT NULL DEFAULT 1,
  principal_user_id uuid        NOT NULL,
  conversation_id   uuid,
  trigger           text        NOT NULL,
  objective_json    jsonb       NOT NULL,
  program_id        uuid,
  program_version   integer     NOT NULL DEFAULT 0,
  status            text        NOT NULL DEFAULT 'CREATED',
  status_reason     text,
  replan_count      integer     NOT NULL DEFAULT 0,
  pending_json      jsonb,
  checkpoint_json   jsonb,
  result_json       jsonb,
  error_json        jsonb,
  cost_cents        integer     NOT NULL DEFAULT 0,
  started_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz,
  CONSTRAINT runs_trigger_check CHECK (trigger IN ('chat','schedule','webhook','api','test')),
  CONSTRAINT runs_status_check CHECK (status IN (
    'CREATED','PLANNING','PLANNED','PLAN_REJECTED','EXECUTING','AWAITING_APPROVAL','AWAITING_INPUT',
    'HELD','REPLANNING','COMPENSATING','COMPENSATED','COMPENSATION_FAILED','COMPLETED','FAILED',
    'CANCELLED','NEEDS_ATTENTION')),
  CONSTRAINT runs_workspace_fk FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id),
  CONSTRAINT runs_agent_fk FOREIGN KEY (agent_id, tenant_id) REFERENCES agents (id, tenant_id),
  CONSTRAINT runs_principal_fk FOREIGN KEY (principal_user_id, tenant_id) REFERENCES users (id, tenant_id),
  CONSTRAINT runs_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX runs_tenant_status_idx ON runs (tenant_id, status, started_at DESC);
CREATE INDEX runs_agent_idx ON runs (agent_id, started_at DESC);
CREATE INDEX runs_conversation_idx ON runs (conversation_id, started_at);

CREATE TABLE task_nodes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id                uuid        NOT NULL,
  program_version       integer     NOT NULL,
  parent_id             uuid REFERENCES task_nodes(id) ON DELETE CASCADE,
  step_index            integer     NOT NULL,
  call_seq              integer,
  dsl_node_id           text,
  kind                  text        NOT NULL,
  tool_id               text,
  args_json             jsonb,
  args_digest           text,
  planned_risk          integer,
  planned_reversibility text,
  planned_egress        text,
  planned_taint         text,
  planned_decision      text,
  status                text        NOT NULL DEFAULT 'pending',
  attempt               integer     NOT NULL DEFAULT 0,
  result_json           jsonb,
  effect_json           jsonb,
  error_json            jsonb,
  started_at            timestamptz,
  ended_at              timestamptz,
  CONSTRAINT task_nodes_kind_check CHECK (kind IN ('TOOL_CALL','REASONING','RESOLVE','HUMAN_INPUT','CHECKPOINT','VERIFY','COMPENSATE')),
  CONSTRAINT task_nodes_status_check CHECK (status IN ('pending','gated','approving','running','held','done','failed','skipped','compensated','unknown')),
  CONSTRAINT task_nodes_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE
);
-- Plan identity: one row per planned step of a program version. A call site that runs more
-- than once (a call inside `map`) adds child rows (parent_id) for the extra invocations.
CREATE UNIQUE INDEX task_nodes_plan_unique ON task_nodes (run_id, program_version, kind, step_index) WHERE parent_id IS NULL;
-- Journal identity: the Nth invocation of a kind in a program version. Replay looks rows up by
-- this key; the interpreter is deterministic, so the Nth call of a re-run IS the Nth call.
CREATE UNIQUE INDEX task_nodes_journal_unique ON task_nodes (run_id, program_version, kind, call_seq) WHERE call_seq IS NOT NULL;
CREATE INDEX task_nodes_run_idx ON task_nodes (tenant_id, run_id, program_version, step_index);

CREATE TABLE actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        uuid        NOT NULL,
  node_id       uuid        NOT NULL REFERENCES task_nodes(id) ON DELETE CASCADE,
  tool_id       text        NOT NULL,
  args_digest   text        NOT NULL,
  effect_json   jsonb,
  taint_level   text        NOT NULL,
  reversibility text        NOT NULL,
  risk_score    integer,
  risk_tier     text,
  state         text        NOT NULL DEFAULT 'PLANNED',
  committed_at  timestamptz,
  released_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actions_state_check CHECK (state IN ('PLANNED','HELD','COMMITTED','COMPENSATED','FAILED','REVOKED','UNKNOWN')),
  CONSTRAINT actions_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX actions_run_idx ON actions (tenant_id, run_id);
-- One action per executed call (its journal row).
CREATE UNIQUE INDEX actions_node_unique ON actions (node_id);

CREATE TABLE replans (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id         uuid        NOT NULL,
  from_step      integer     NOT NULL,
  from_version   integer     NOT NULL,
  reason         text        NOT NULL,
  detail_json    jsonb,
  new_program_id uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT replans_reason_check CHECK (reason IN ('tool_failure','verify_failure','policy_denial','lock_timeout','precondition_invalid','human_modification','invalid_program','clarification')),
  CONSTRAINT replans_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE
);

-- Every saved spec is a version: runs reference the version they ran (receipts, M7).
CREATE TABLE agent_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id   uuid        NOT NULL,
  version    integer     NOT NULL,
  spec_json  jsonb       NOT NULL,
  created_by uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_versions_agent_fk FOREIGN KEY (agent_id, tenant_id) REFERENCES agents (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (agent_id, version)
);

CREATE TABLE conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid        NOT NULL,
  agent_id     uuid        NOT NULL,
  user_id      uuid        NOT NULL,
  title        text        NOT NULL DEFAULT 'New conversation',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_agent_fk FOREIGN KEY (agent_id, tenant_id) REFERENCES agents (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT conversations_user_fk FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id),
  CONSTRAINT conversations_id_tenant_key UNIQUE (id, tenant_id)
);
CREATE INDEX conversations_user_idx ON conversations (tenant_id, user_id, updated_at DESC);

CREATE TABLE conversation_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid        NOT NULL,
  role            text        NOT NULL,
  body            text        NOT NULL,
  run_id          uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_messages_role_check CHECK (role IN ('user','agent','system')),
  CONSTRAINT conversation_messages_conv_fk FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX conversation_messages_idx ON conversation_messages (tenant_id, conversation_id, created_at);

-- Schedule triggers fire at most once per (agent, fire time), however many replicas evaluate them.
CREATE TABLE trigger_fires (
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id   uuid        NOT NULL,
  fire_at    timestamptz NOT NULL,
  run_id     uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, fire_at)
);

-- The interpreter's provenance rows are written again when a durable run replays: make them
-- idempotent (one row per run step / source / violation). Existing exact duplicates (from
-- re-seeding development databases) are collapsed first; they are identical rows.
DELETE FROM derivations a USING derivations b
 WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.run_id = b.run_id AND a.step_index = b.step_index AND a.op = b.op AND a.value_ref = b.value_ref;
DELETE FROM sources a USING sources b
 WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.run_id IS NOT DISTINCT FROM b.run_id AND a.uri = b.uri AND a.digest = b.digest;
DELETE FROM taint_violations a USING taint_violations b
 WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.run_id = b.run_id AND a.program_ref = b.program_ref
   AND coalesce(a.node_id, '') = coalesce(b.node_id, '') AND a.kind = b.kind AND a.arg_path = b.arg_path;
DELETE FROM programs a USING programs b
 WHERE a.ctid < b.ctid AND a.tenant_id = b.tenant_id AND a.run_id = b.run_id AND a.ast_digest = b.ast_digest;
CREATE UNIQUE INDEX derivations_run_step_unique ON derivations (tenant_id, run_id, step_index, op, value_ref);
CREATE UNIQUE INDEX sources_run_uri_unique ON sources (tenant_id, run_id, uri, digest);
CREATE UNIQUE INDEX taint_violations_unique ON taint_violations (tenant_id, run_id, program_ref, coalesce(node_id, ''), kind, arg_path);
CREATE UNIQUE INDEX programs_run_digest_unique ON programs (tenant_id, run_id, ast_digest) WHERE version IS NULL;
CREATE UNIQUE INDEX programs_run_version_unique ON programs (tenant_id, run_id, version) WHERE version IS NOT NULL;

-- ============ Outbound webhooks (docs/module4.md §7; later modules add event kinds) ============
-- platform_events is the outbox; a delivery worker in the control plane posts each matching
-- event, HMAC-signed, through the isolated web-fetch service (public addresses only).
CREATE TABLE webhook_endpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  url           text        NOT NULL CHECK (url ~ '^https://'),
  event_kinds   text[]      NOT NULL,
  secret_sealed text        NOT NULL,
  active        boolean     NOT NULL DEFAULT true,
  created_by    uuid        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_event_id bigint      NOT NULL DEFAULT 0
);
CREATE TABLE webhook_deliveries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  endpoint_id  uuid        NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_id     bigint      NOT NULL,
  kind         text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts     integer     NOT NULL DEFAULT 0,
  last_status  integer,
  last_error   text,
  next_at      timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (endpoint_id, event_id)
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (tenant_id, status, next_at);

-- ============ The scheduler role (the pattern of vega_auth, 0002) ============
-- The coordinator, scheduler and webhook worker must find work ACROSS tenants without an
-- owner connection. SECURITY DEFINER functions owned by a NOLOGIN role return ids and
-- statuses only; everything else is then read under withTenant() like any request.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vega_sched') THEN
    CREATE ROLE vega_sched NOLOGIN;
  END IF;
END
$$;

CREATE FUNCTION sched_run_queue(p_statuses text[], p_limit integer)
  RETURNS TABLE (tenant_id uuid, run_id uuid, status text, updated_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT r.tenant_id, r.id, r.status, r.updated_at FROM runs r
   WHERE r.status = ANY (p_statuses)
   ORDER BY r.updated_at
   LIMIT least(p_limit, 500)
$$;

CREATE FUNCTION sched_schedule_agents()
  RETURNS TABLE (tenant_id uuid, agent_id uuid, triggers jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT a.tenant_id, a.id, a.spec_json->'triggers' FROM agents a
   WHERE a.status = 'active' AND jsonb_path_exists(a.spec_json, '$.triggers[*] ? (@.kind == "schedule")')
$$;

-- An inbound webhook trigger: agent id + the hash of the presented secret → its tenant, or nothing.
CREATE FUNCTION sched_webhook_agent(p_agent_id uuid, p_secret_hash text)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT a.tenant_id FROM agents a
   WHERE a.id = p_agent_id AND a.status = 'active' AND a.webhook_secret_hash IS NOT NULL AND a.webhook_secret_hash = p_secret_hash
$$;

CREATE FUNCTION sched_webhook_tenants()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
AS $$
  SELECT DISTINCT e.tenant_id FROM webhook_endpoints e WHERE e.active
$$;

CREATE POLICY sched_read ON runs              FOR SELECT TO vega_sched USING (true);
CREATE POLICY sched_read ON agents            FOR SELECT TO vega_sched USING (true);
CREATE POLICY sched_read ON webhook_endpoints FOR SELECT TO vega_sched USING (true);
GRANT USAGE ON SCHEMA public TO vega_sched;
GRANT SELECT (id, tenant_id, status, updated_at) ON runs TO vega_sched;
GRANT SELECT (id, tenant_id, status, spec_json, webhook_secret_hash) ON agents TO vega_sched;
GRANT SELECT (tenant_id, active) ON webhook_endpoints TO vega_sched;
ALTER FUNCTION sched_run_queue(text[], integer) OWNER TO vega_sched;
ALTER FUNCTION sched_schedule_agents() OWNER TO vega_sched;
ALTER FUNCTION sched_webhook_agent(uuid, text) OWNER TO vega_sched;
ALTER FUNCTION sched_webhook_tenants() OWNER TO vega_sched;
REVOKE ALL ON FUNCTION sched_run_queue(text[], integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION sched_schedule_agents() FROM PUBLIC;
REVOKE ALL ON FUNCTION sched_webhook_agent(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION sched_webhook_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sched_run_queue(text[], integer) TO vega_app;
GRANT EXECUTE ON FUNCTION sched_schedule_agents() TO vega_app;
GRANT EXECUTE ON FUNCTION sched_webhook_agent(uuid, text) TO vega_app;
GRANT EXECUTE ON FUNCTION sched_webhook_tenants() TO vega_app;

-- Run progress is streamed from platform_events (SSE, docs/module4.md §6.1).
CREATE INDEX platform_events_run_idx ON platform_events (tenant_id, (payload->>'runId'), id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['runs','task_nodes','actions','replans','agent_versions','conversations','conversation_messages','trigger_fires','webhook_endpoints','webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON runs, task_nodes, actions, replans, agent_versions, conversations, conversation_messages, trigger_fires, webhook_endpoints, webhook_deliveries TO vega_app;
