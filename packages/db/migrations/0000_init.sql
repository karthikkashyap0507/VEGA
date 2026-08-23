-- =============================================================================
-- 0000_init — Module 1 foundation tables
--
-- Spec: docs/module1.md §4
-- RLS is applied separately in 0001_rls.sql so the security boundary is reviewable
-- on its own, without table noise around it.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

-- ============================== Tenancy ======================================

CREATE TABLE tenants (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name           text        NOT NULL,
  slug           citext      NOT NULL UNIQUE,
  plan           text        NOT NULL DEFAULT 'free',
  region         text        NOT NULL DEFAULT 'eu-west-1',
  -- EU AI Act Art. 12 floor is 180 days. Enforced here as well as in the Zod schema,
  -- because a CHECK constraint cannot be bypassed by a caller that skips validation.
  retention_days integer     NOT NULL DEFAULT 400 CHECK (retention_days >= 180),
  idp_org_id     text,
  billing_ref    text,
  settings       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status         text        NOT NULL DEFAULT 'active',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenants_plan_check
    CHECK (plan IN ('free', 'pro', 'business', 'teams', 'enterprise')),
  CONSTRAINT tenants_status_check
    CHECK (status IN ('active', 'suspended', 'closed'))
);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email        citext      NOT NULL,
  display_name text,
  role         text        NOT NULL DEFAULT 'MEMBER',
  idp_subject  text UNIQUE,
  status       text        NOT NULL DEFAULT 'invited',
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique_per_tenant UNIQUE (tenant_id, email),
  CONSTRAINT users_role_check CHECK (role IN (
    'OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'WORKFLOW_OWNER',
    'APPROVER', 'MEMBER', 'AUDITOR'
  )),
  CONSTRAINT users_status_check CHECK (status IN ('active', 'invited', 'deactivated'))
);
CREATE INDEX users_tenant_idx ON users (tenant_id);

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        text        NOT NULL,
  slug        citext      NOT NULL,
  settings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_slug_unique_per_tenant UNIQUE (tenant_id, slug)
);
CREATE INDEX workspaces_tenant_idx ON workspaces (tenant_id);

-- NOTE: `tenant_id` is denormalised here on purpose.
-- module1.md §4 models this as (workspace_id, user_id) only, but an RLS policy that has to
-- reach through a join is both slower and easier to get wrong. Carrying tenant_id lets the
-- policy be the same single-column predicate as every other table. The FK pair below keeps
-- it honest — a member row cannot point at a workspace in a different tenant.
CREATE TABLE workspace_members (
  tenant_id    uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id uuid        NOT NULL,
  user_id      uuid        NOT NULL,
  role         text        NOT NULL DEFAULT 'member',
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT workspace_members_role_check CHECK (role IN ('owner', 'admin', 'member'))
);
CREATE INDEX workspace_members_tenant_idx ON workspace_members (tenant_id);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

-- Composite uniqueness so the cross-tenant FKs below can exist.
ALTER TABLE workspaces ADD CONSTRAINT workspaces_id_tenant_key UNIQUE (id, tenant_id);
ALTER TABLE users      ADD CONSTRAINT users_id_tenant_key      UNIQUE (id, tenant_id);

ALTER TABLE workspace_members
  ADD CONSTRAINT workspace_members_workspace_fk
  FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id) ON DELETE CASCADE;
ALTER TABLE workspace_members
  ADD CONSTRAINT workspace_members_user_fk
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE;

-- ===================== Agent identity (agents are principals) ================
-- module1.md §5.5: an agent has its OWN identity, distinct from the user it acts for.
-- Every downstream action records both, or M7 receipts and M10 autonomy decisions are
-- unattributable.
CREATE TABLE agents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  workspace_id   uuid        NOT NULL,
  name           text        NOT NULL,
  version        integer     NOT NULL DEFAULT 1,
  spec_json      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  owner_user_id  uuid        NOT NULL,
  idp_machine_id text,
  status         text        NOT NULL DEFAULT 'draft',
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agents_name_version_unique UNIQUE (workspace_id, name, version),
  CONSTRAINT agents_status_check
    CHECK (status IN ('draft', 'active', 'suspended', 'archived')),
  CONSTRAINT agents_workspace_fk
    FOREIGN KEY (workspace_id, tenant_id) REFERENCES workspaces (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT agents_owner_fk
    FOREIGN KEY (owner_user_id, tenant_id) REFERENCES users (id, tenant_id)
);
CREATE INDEX agents_tenant_idx ON agents (tenant_id);

-- ===================== Entitlements: tiers are DATA (D-09) ===================
-- Global reference data, NOT tenant-scoped: every tenant reads the same rows.
-- Adding a plan is an INSERT, not a release.
--
-- Note what is absent: `undo` and `taint_defense` are not entitlements and must never
-- become one (decision D-10). A contracts test asserts this too.
CREATE TABLE plan_entitlements (
  plan       text PRIMARY KEY,
  limits     jsonb       NOT NULL,
  exposed    jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT plan_entitlements_plan_check
    CHECK (plan IN ('free', 'pro', 'business', 'teams', 'enterprise'))
);

-- ===================== Secret vault (populated by M2) ========================
-- Envelope-encrypted. Plaintext never lands in Postgres — see packages/shared/src/crypto.ts.
CREATE TABLE secret_refs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  purpose    text        NOT NULL,
  kms_key_id text        NOT NULL,
  wrapped_dek bytea      NOT NULL,
  ciphertext bytea       NOT NULL,
  iv         bytea       NOT NULL,
  auth_tag   bytea       NOT NULL,
  meta       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX secret_refs_tenant_idx ON secret_refs (tenant_id);

-- ===================== Platform events =======================================
-- Operational telemetry. This is NOT the audit chain — that lives in the evidence
-- plane (M7) and is signed. Never hand an auditor rows from this table.
CREATE TABLE platform_events (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_id   uuid,
  kind       text        NOT NULL,
  payload    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_events_tenant_created_idx ON platform_events (tenant_id, created_at DESC);
