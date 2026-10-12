-- =============================================================================
-- Evidence plane — 0001_chain (Module 7: the signed hash chain, docs/module7.md §4.1)
--
-- Runs against the SEPARATE evidence instance. Every table here is append-only: the same
-- trigger as the inbox refuses UPDATE, DELETE and TRUNCATE for every role, the owner included.
-- Corrections are new rows (a pack build is a second row next to its request; a redaction is a
-- row and a chain entry; a rotated key is a new key whose not_before ends the old one's term).
--
-- Roles (infra/docker/initdb/evidence/01-roles.sql):
--   vega_evi_writer  INSERT on every table + EXECUTE evidence_chain_head(). No SELECT: the
--                    append path learns the head through that one function and nothing else.
--   vega_evi_reader  SELECT on every table: queries, packs, replay, verification.
-- The execution plane holds neither; it reaches this database only through POST /append.
-- =============================================================================

-- ------------------------------------------------------------------ the chain
-- Hash-partitioned by tenant from day one (§13 "chain size and query performance"): every
-- query is per tenant, and a tenant's chain is one partition's index range.
CREATE TABLE IF NOT EXISTS audit_entries (
  tenant_id      uuid        NOT NULL,
  seq            bigint      NOT NULL CHECK (seq >= 1),   -- per tenant, gapless, from 1
  id             uuid        NOT NULL,
  ts             timestamptz NOT NULL,                    -- hashed as RFC 3339 with milliseconds
  kind           text        NOT NULL,
  source         text        NOT NULL,                    -- execution | control | evidence
  payload_json   jsonb       NOT NULL,                    -- the receipt (§5.1): digests, never plaintext
  payload_digest text        NOT NULL,
  prev_hash      text        NOT NULL,
  entry_hash     text        NOT NULL,
  signature      text        NOT NULL,                    -- ML-DSA-65 over "vega-entry-v1\n" ‖ entry_hash
  key_id         text        NOT NULL,
  leaf_index     bigint      NOT NULL,                    -- the RFC 6962 log position: seq − 1
  -- Facets for the Audit Explorer (§6.1). Derived from the payload at append time and NOT part
  -- of the hash — anyone can recompute them from the payload, which is.
  run_id         text,
  action_id      text,
  actor          text,
  agent_id       text,
  tool_id        text,
  connector_id   text,
  risk_tier      text,
  decision       text,
  outcome        text,
  subjects       text[]      NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, seq),
  UNIQUE (tenant_id, entry_hash),
  UNIQUE (tenant_id, id),
  CHECK (leaf_index = seq - 1)
) PARTITION BY HASH (tenant_id);

DO $$
BEGIN
  FOR i IN 0..7 LOOP
    EXECUTE format('CREATE TABLE IF NOT EXISTS audit_entries_p%s PARTITION OF audit_entries FOR VALUES WITH (MODULUS 8, REMAINDER %s)', i, i);
  END LOOP;
END
$$;

CREATE INDEX IF NOT EXISTS audit_entries_ts ON audit_entries (tenant_id, ts);
CREATE INDEX IF NOT EXISTS audit_entries_kind ON audit_entries (tenant_id, kind, seq);
CREATE INDEX IF NOT EXISTS audit_entries_run ON audit_entries (tenant_id, run_id, seq) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_entries_action ON audit_entries (tenant_id, action_id) WHERE action_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_entries_tool ON audit_entries (tenant_id, tool_id, seq) WHERE tool_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_entries_agent ON audit_entries (tenant_id, agent_id, seq) WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS audit_entries_subjects ON audit_entries USING gin (subjects);

/**
 * The ONLY read the append path has: a tenant's head (seq and entry_hash), so the next entry can
 * chain to it. SECURITY DEFINER runs it as the owner; the writer gets EXECUTE on this and no
 * SELECT on any table — it can learn where the chain ends, never what it says.
 */
CREATE OR REPLACE FUNCTION evidence_chain_head(t uuid)
  RETURNS TABLE (seq bigint, entry_hash text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.seq, e.entry_hash FROM audit_entries e WHERE e.tenant_id = t ORDER BY e.seq DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION evidence_chain_head(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION evidence_chain_head(uuid) TO vega_evi_writer;

-- ------------------------------------------------------------------ keys (§5.3)
-- Public keys are kept indefinitely so historical entries stay verifiable. A key's term ends
-- where the next key's begins (not_after is derived, so rotation is an INSERT).
CREATE TABLE IF NOT EXISTS signing_keys (
  key_id     text        PRIMARY KEY,
  alg        text        NOT NULL,
  public_key text        NOT NULL,
  not_before timestamptz NOT NULL,
  custody    text        NOT NULL,                        -- local | kms | customer
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ anchors (§5.4)
-- A signed tree head over a tenant's log. `published` anchors are what
-- /.well-known/vega/anchors/<tenant> serves; an RFC 3161 token, when a TSA is configured, is
-- kept with the head it timestamps.
CREATE TABLE IF NOT EXISTS anchors (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  chain_head_seq  bigint      NOT NULL,
  chain_head_hash text        NOT NULL,
  tree_size       bigint      NOT NULL,
  root_hash       text        NOT NULL,
  method          text        NOT NULL,                   -- published | rfc3161 | trillian
  external_ref    text,
  timestamp_token text,
  key_id          text        NOT NULL,
  signature       text        NOT NULL,
  anchored_at     timestamptz NOT NULL,
  UNIQUE (tenant_id, tree_size),
  CHECK (tree_size = chain_head_seq)
);
CREATE INDEX IF NOT EXISTS anchors_tenant ON anchors (tenant_id, tree_size DESC);

-- ------------------------------------------------------------------ content (§4.2, §5.5)
-- The content-addressed store's index. Bytes live in object storage under storage_key; the
-- chain commits to the digest. A redaction removes the bytes and adds a row below — this row
-- and the chain entry that referenced the digest stay.
CREATE TABLE IF NOT EXISTS content_objects (
  tenant_id   uuid        NOT NULL,
  digest      text        NOT NULL,
  size_bytes  integer     NOT NULL,
  media_type  text        NOT NULL,
  sensitivity text        NOT NULL DEFAULT 'body',        -- body | metadata (AUDITOR sees metadata)
  storage_key text        NOT NULL,
  stored_at   timestamptz NOT NULL DEFAULT now(),
  retain_until timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, digest)
);

CREATE TABLE IF NOT EXISTS redactions (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  digest       text        NOT NULL,
  request_id   text        NOT NULL,
  reason       text        NOT NULL,
  requested_by text        NOT NULL,
  entry_seq    bigint      NOT NULL,                      -- the `redaction` chain entry
  redacted_at  timestamptz NOT NULL,
  UNIQUE (tenant_id, digest)
);

-- ------------------------------------------------------------------ packs (§5.6)
CREATE TABLE IF NOT EXISTS evidence_packs (
  id           uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  query_json   jsonb       NOT NULL,
  requested_by text        NOT NULL,
  include_bodies boolean   NOT NULL DEFAULT false,
  requested_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);
CREATE INDEX IF NOT EXISTS evidence_packs_tenant ON evidence_packs (tenant_id, requested_at DESC);

-- The outcome of a build: a second row, never an update of the request.
CREATE TABLE IF NOT EXISTS evidence_pack_builds (
  pack_id      uuid        PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  status       text        NOT NULL CHECK (status IN ('built', 'failed')),
  entry_count  integer,
  artifact_ref text,                                      -- WORM object storage
  digest       text,
  signature    text,
  size_bytes   integer,
  duration_ms  integer     NOT NULL,
  error        text,
  entry_seq    bigint,                                    -- every build is itself a chain entry
  built_at     timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ replay (§5.7)
CREATE TABLE IF NOT EXISTS replay_runs (
  id              uuid        PRIMARY KEY,
  tenant_id       uuid        NOT NULL,
  action_id       text        NOT NULL,
  entry_seq       bigint      NOT NULL,
  original_digest text        NOT NULL,
  replay_digest   text        NOT NULL,
  matched         boolean     NOT NULL,                   -- the deterministic layers
  layers_json     jsonb       NOT NULL,
  divergence_json jsonb,
  requested_by    text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS replay_runs_action ON replay_runs (tenant_id, action_id, created_at DESC);

-- ------------------------------------------------------------------ continuous verification (§10)
CREATE TABLE IF NOT EXISTS chain_verifications (
  id         uuid        PRIMARY KEY,
  tenant_id  uuid        NOT NULL,
  ok         boolean     NOT NULL,
  entries    bigint      NOT NULL,
  head_seq   bigint,
  detail_json jsonb      NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chain_verifications_tenant ON chain_verifications (tenant_id, checked_at DESC);

-- ------------------------------------------------------------------ append-only, every table
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'audit_entries', 'audit_entries_p0', 'audit_entries_p1', 'audit_entries_p2', 'audit_entries_p3',
    'audit_entries_p4', 'audit_entries_p5', 'audit_entries_p6', 'audit_entries_p7',
    'signing_keys', 'anchors', 'content_objects', 'redactions', 'evidence_packs',
    'evidence_pack_builds', 'replay_runs', 'chain_verifications'])
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION evidence_refuse_mutation()', t || '_append_only', t);
    -- A row trigger too: a statement trigger on the parent does not fire for a partition
    -- addressed directly, and an UPDATE that matches no rows must still be refused loudly.
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only_row', t);
    IF t NOT LIKE 'audit_entries' THEN
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION evidence_refuse_mutation()', t || '_append_only_row', t);
    END IF;
    EXECUTE format('GRANT INSERT ON %I TO vega_evi_writer', t);
    EXECUTE format('GRANT SELECT ON %I TO vega_evi_reader', t);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM vega_evi_writer, vega_evi_reader', t);
  END LOOP;
END
$$;

-- The writer reads nothing — not even the partitions' rows through the parent.
REVOKE SELECT ON audit_entries, signing_keys, anchors, content_objects, redactions, evidence_packs,
  evidence_pack_builds, replay_runs, chain_verifications FROM vega_evi_writer;
