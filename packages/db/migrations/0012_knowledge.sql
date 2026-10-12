-- =============================================================================
-- 0012_knowledge — Module 9: Verification, Memory & Knowledge (docs/module9.md §4)
--
-- One substrate (pgvector + provenance), one rule: content that enters the system carries a taint
-- label, and that label decides what it may influence. The `memory_taint_gate` CHECK is the last
-- of three layers keeping untrusted content out of memory (the M3 gate, the memory store, this).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- ============ C6 Verification ============
CREATE TABLE verifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        uuid        NOT NULL,
  node_id       uuid        NOT NULL,
  action_id     uuid,
  agent_id      uuid,                                   -- M10 aggregates by workflow …
  tool_id       text        NOT NULL,                   -- … and by action type (§16)
  phase         text        NOT NULL CHECK (phase IN ('pre_commit','post_commit')),
  checks_json   jsonb       NOT NULL,
  outcome       text        NOT NULL CHECK (outcome IN ('PASS','WARN','ESCALATE','ABORT','COMPENSATE')),
  failed_check  text,
  risk_tier     text,
  duration_ms   integer,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verifications_run_fk FOREIGN KEY (run_id, tenant_id) REFERENCES runs (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX verifications_run_idx ON verifications (tenant_id, run_id, created_at);
CREATE INDEX verifications_m10_idx ON verifications (tenant_id, agent_id, tool_id, created_at DESC);

CREATE TABLE groundedness_findings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  verification_id  uuid        NOT NULL REFERENCES verifications(id) ON DELETE CASCADE,
  claim_text       text        NOT NULL,
  claim_kind       text        NOT NULL,                 -- number|date|price|commitment|fact|pleasantry
  claim_span       int4range,
  field            text,
  verdict          text        NOT NULL CHECK (verdict IN ('SUPPORTED','UNSUPPORTED','CONTRADICTED')),
  supported        boolean     NOT NULL,
  source_ids       text[]      NOT NULL DEFAULT '{}',
  confidence       numeric     NOT NULL,
  severity         text        NOT NULL CHECK (severity IN ('INFO','WARN','BLOCK'))
);
CREATE INDEX groundedness_verification_idx ON groundedness_findings (verification_id);

-- Denormalized for M10's months-long scans (§16).
ALTER TABLE runs ADD COLUMN verification_summary jsonb;

-- ============ C7 Memory ============
CREATE TABLE memories (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope            text        NOT NULL CHECK (scope IN ('user','workspace','tenant')),
  subject_id       uuid        NOT NULL,
  class            text        NOT NULL CHECK (class IN ('preference','working_context','task_history','org_knowledge','long_term_style')),
  content          text        NOT NULL CHECK (length(content) BETWEEN 1 AND 2000),
  embedding        vector(1024),
  provenance_json  jsonb       NOT NULL,
  source_taint     text        NOT NULL,
  confidence       numeric     NOT NULL DEFAULT 0.5 CHECK (confidence BETWEEN 0 AND 1),
  created_from_run uuid,
  created_by       uuid,
  valid_from       timestamptz NOT NULL DEFAULT now(),
  valid_to         timestamptz,
  superseded_by    uuid REFERENCES memories(id),
  user_edited      boolean     NOT NULL DEFAULT false,
  pinned           boolean     NOT NULL DEFAULT false,
  stale            boolean     NOT NULL DEFAULT false,
  last_used_at     timestamptz,
  use_count        integer     NOT NULL DEFAULT 0,
  -- THE T2 DEFENSE, last layer: untrusted content can never become a memory, by any path.
  CONSTRAINT memory_taint_gate CHECK (source_taint IN ('TRUSTED','ORG'))
);
CREATE INDEX memories_embedding_idx ON memories USING hnsw (embedding vector_cosine_ops);
CREATE INDEX memories_active_idx ON memories (tenant_id, scope, subject_id, class) WHERE valid_to IS NULL;

CREATE TABLE memory_conflicts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  existing_id   uuid        NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  proposed_json jsonb       NOT NULL,
  similarity    numeric,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  resolution    text        CHECK (resolution IN ('keep_existing','accept_new','merge','both_valid')),
  resolved_by   uuid,
  resolved_at   timestamptz
);
CREATE INDEX memory_conflicts_open_idx ON memory_conflicts (tenant_id, detected_at DESC) WHERE resolution IS NULL;

-- ============ P4 Knowledge base ============
CREATE TABLE kb_documents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id   uuid,
  source_kind    text        NOT NULL CHECK (source_kind IN ('upload','gdrive','sharepoint','url','email_attachment')),
  external_ref   text,
  title          text        NOT NULL,
  content_ref    text        NOT NULL,
  content_digest text        NOT NULL,
  mime           text        NOT NULL,
  sensitivity    integer     NOT NULL DEFAULT 0,
  labels         text[]      NOT NULL DEFAULT '{}',
  -- §7.4: an external attachment or web content is UNTRUSTED however it entered the index.
  taint          text        NOT NULL DEFAULT 'ORG' CHECK (taint IN ('TRUSTED','ORG','UNTRUSTED')),
  acl_ref        text        NOT NULL,
  acl_users      uuid[]      NOT NULL DEFAULT '{}',
  created_by     uuid,
  indexed_at     timestamptz,
  state          text        NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','indexed','failed','stale')),
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT kb_external_untrusted CHECK (source_kind NOT IN ('email_attachment','url') OR taint = 'UNTRUSTED')
);
CREATE INDEX kb_documents_tenant_idx ON kb_documents (tenant_id, created_at DESC);

CREATE TABLE kb_chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  document_id   uuid        NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  ordinal       integer     NOT NULL,
  content       text        NOT NULL,
  heading_path  text[]      NOT NULL DEFAULT '{}',
  embedding     vector(1024),
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  token_count   integer     NOT NULL
);
CREATE INDEX kb_chunks_embedding_idx ON kb_chunks USING hnsw (embedding vector_cosine_ops);
CREATE INDEX kb_chunks_tsv_idx ON kb_chunks USING gin (tsv);
CREATE INDEX kb_chunks_document_idx ON kb_chunks (document_id, ordinal);

CREATE TABLE retrievals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  run_id        uuid,
  purpose       text        NOT NULL DEFAULT 'planning',  -- planning|groundedness|search
  requested_by  uuid,
  query         text        NOT NULL,
  chunk_ids     uuid[]      NOT NULL,
  memory_ids    uuid[]      NOT NULL,
  scores_json   jsonb       NOT NULL DEFAULT '[]',
  acl_filtered  integer     NOT NULL,
  sensitivity_filtered integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrievals_run_idx ON retrievals (tenant_id, run_id, created_at);

-- ============ Row-level security ============
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['verifications','groundedness_findings','memories','memory_conflicts','kb_documents','kb_chunks','retrievals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON memories, memory_conflicts, kb_documents, kb_chunks TO vega_app;
-- Verifications and their findings, and the retrieval log, are records.
REVOKE UPDATE, DELETE, TRUNCATE ON verifications, groundedness_findings, retrievals FROM vega_app;
GRANT SELECT, INSERT ON verifications, groundedness_findings, retrievals TO vega_app;
