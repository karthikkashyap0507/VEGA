-- =============================================================================
-- Evidence plane — 0000_inbox (Module 1 stub; Module 7 builds the signed chain on top)
--
-- Runs against the SEPARATE evidence instance (vega-evidence, :5433 locally).
--
-- INVARIANT 1 (PROJECT.md §10.2), layer 3 of 4: a trigger that makes UPDATE and DELETE
-- impossible even for a role that somehow acquired the grant. Layer 2 is the INSERT-only
-- grant in infra/docker/initdb/evidence/01-roles.sql; layer 1 is network policy; layer 4 is
-- KMS IAM on the signing key (Module 7).
-- =============================================================================

-- The writer supplies `id`: an INSERT-only role cannot use RETURNING (that needs SELECT),
-- and it must not need to — a receipt the caller can compute is one the plane never has to
-- read back. `seq` records arrival order for Module 7's chain.
CREATE TABLE IF NOT EXISTS evidence_inbox (
  id          uuid        PRIMARY KEY,
  seq         bigserial   NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  tenant_id   uuid        NOT NULL,
  source      text        NOT NULL,
  kind        text        NOT NULL,
  payload     jsonb       NOT NULL
);

CREATE OR REPLACE FUNCTION evidence_refuse_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence is append-only: % on % is forbidden (invariant 1)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;

DROP TRIGGER IF EXISTS evidence_inbox_append_only ON evidence_inbox;
CREATE TRIGGER evidence_inbox_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON evidence_inbox
  FOR EACH STATEMENT EXECUTE FUNCTION evidence_refuse_mutation();

-- Default privileges from 01-roles.sql cover tables created by the owner after it ran;
-- restate them here so the grant is visible next to the table it protects.
GRANT INSERT ON evidence_inbox TO vega_evi_writer;
GRANT USAGE ON SEQUENCE evidence_inbox_seq_seq TO vega_evi_writer;
GRANT SELECT ON evidence_inbox TO vega_evi_reader;
REVOKE UPDATE, DELETE, TRUNCATE ON evidence_inbox FROM vega_evi_writer, vega_evi_reader;
