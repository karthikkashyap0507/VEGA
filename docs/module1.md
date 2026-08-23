# Module 1 — Foundation & Tenancy

> The skeleton every other module hangs on: monorepo, four-plane deployment topology, hard
> multi-tenancy, identity, authorization, the API gateway, the web shell, and the CI gates that
> enforce architectural invariants mechanically.

| | |
|---|---|
| **Phase** | 1 (months 2–3) |
| **Covers** | P1 (Identity, RBAC, Tenancy), PROJECT.md §10 architecture, §16–§21 |
| **Depends on** | Nothing (first module) |
| **Blocks** | All modules |
| **Estimate** | 5–7 engineer-weeks |

---

## 1. Purpose & Scope

### 1.1 What this module delivers

A running, deployable, empty product. A user can sign up, belong to a tenant, create a workspace,
invite a colleague, and see six surface shells. No agent runs yet — but the tenancy boundary,
the plane separation, and the build-time invariant enforcement are real from this point on.

### 1.2 Why it must come first

Three things in PROJECT.md cannot be retrofitted:

1. **Row-level tenancy.** Adding RLS to a schema with existing query paths means auditing every
   query ever written. Start with it enforced.
2. **Plane separation** (invariant 1). If the execution plane ever shares a database connection
   with the evidence plane, the audit chain's guarantee is void — and the code that assumes shared
   access spreads fast.
3. **Agent identity distinct from user identity.** If actions are attributed only to users,
   every audit receipt in Module 7 is wrong and every autonomy decision in Module 10 is
   unattributable.

### 1.3 In scope

- pnpm + Turborepo monorepo, `packages/contracts`, `packages/shared` (incl. `brand.ts`)
- PostgreSQL schema foundation with RLS on every tenant-scoped table
- Zitadel identity: organizations, human users, machine users (agent identities), OIDC/SAML/SCIM
- OpenFGA authorization model and check middleware
- Fastify public API + tRPC internal API + shared Zod contracts
- Next.js app shell with all six surfaces routed and stubbed
- Design system: Tailwind + shadcn/ui, theme tokens, light/dark
- Custom ESLint rules enforcing PROJECT.md §10.2 invariants
- OpenTelemetry baseline; SigNoz self-hosted
- Kubernetes topology: four namespaces, default-deny Cilium policies, mTLS
- `docker compose` local stack; CI pipeline with gate skeleton
- Secrets: OpenBao / External Secrets; connector token vault schema (used in Module 2)
- **Plan/tier enforcement primitives** and the self-serve signup path (PROJECT.md D-09)

### 1.4 Out of scope

Agent execution (M4) · connectors (M2) · policy evaluation (M5) · audit chain (M7) · anything
that touches an LLM. Billing *integration* is deferred to M10/P5; the **plan model and entitlement
checks are built here**, because retrofitting them touches every surface.

### 1.5 The subset architecture constraint (PROJECT.md §22.1, decision D-09)

> Every tier runs the same engine. Tiers differ only in what is **exposed**, never in what is
> **built**.

This binds M1 hardest, because tenancy is where tiers live. Three rules, from day one:

1. **`tenants.plan` gates feature *exposure*, never code paths.** There is no
   `if (plan === 'enterprise')` wrapped around business logic — only around what the UI renders
   and which API surfaces are reachable. A second code path is a second product, which is exactly
   the failure mode this constraint exists to prevent.
2. **Entitlements are data, not conditionals.** `plan_entitlements` maps plan to limits and
   exposed surfaces. Adding a tier is a row, not a release.
3. **Undo (D1) and taint defense (D4) are never entitlement-gated** (decision D-10). They ship
   identically in the free tier, because they are the reason anyone would choose us over a free
   assistant.

**The self-serve signup path is built here** even though the SMB motion launches later
(§22.3 stage 2): email signup, tenant and workspace provisioned automatically, connector
authorize, first run — target under 5 minutes with no human involved. Building it later means
reworking tenant provisioning, and every module depends on that.

---

## 2. Dependencies

**Upstream:** none.

**Downstream — everything.** Specifically, later modules assume these exist:

| Consumer | Requires from M1 |
|---|---|
| M2 Connectors | Tenant context, token vault, OpenBao |
| M4 Agent Core | Agent machine identities, workspace scoping |
| M5 Policy | Role model, OpenFGA tuples |
| M7 Evidence | Plane separation, INSERT-only DB grants |
| M8 Approvals | Roles (`APPROVER`, `REGISTERED_PRINCIPAL`), notification identities |
| M10 Scale | Workspace model, tenant settings |

---

## 3. Architecture

### 3.1 Deployment topology

Four Kubernetes namespaces mapping to PROJECT.md §10.1 planes. Separation is enforced by network
policy and IAM, not by application code.

```
ns: vega-experience     web (Next.js), mobile BFF
        │ mTLS
ns: vega-control        gateway, control services
        │ mTLS
ns: vega-execution      execution services, connector runtime
        │  ── INSERT-only, one direction ──▶
ns: vega-evidence       evidence services  (separate DB, separate KMS key)
```

**Cilium default-deny in every namespace.** Explicit allow rules only:

| From | To | Allowed |
|---|---|---|
| experience | control | HTTPS 443 |
| control | execution | HTTPS 443 |
| execution | evidence | HTTPS 443, `/append` only |
| evidence | execution | **none** |
| execution | evidence-db | **none** |

### 3.2 Database topology

Two physically separate PostgreSQL instances:

| Instance | Owner | Grants |
|---|---|---|
| `vega-primary` | control + execution | Full DML on their schemas, RLS enforced |
| `vega-evidence` | evidence plane only | Execution plane has **no credential at all** |

The execution plane reaches the evidence plane only through the evidence service's `/append`
endpoint. This is verified by a CI policy test (§11.4).

---

## 4. Data Model

Foundation tables. Every tenant-scoped table carries `tenant_id` and an RLS policy.

```sql
-- ============ Tenancy ============
CREATE TABLE tenants (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,
  slug            citext UNIQUE NOT NULL,
  plan            text NOT NULL DEFAULT 'free',        -- free|pro|business|teams|enterprise
  billing_ref     text,                                -- provider customer id (M10/P5)
  region          text NOT NULL DEFAULT 'eu-west-1',   -- data residency
  retention_days  int  NOT NULL DEFAULT 400,           -- >= 180, EU AI Act Art.12 floor
  idp_org_id      text NOT NULL,                       -- Zitadel organization id
  settings        jsonb NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'active',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  email        citext NOT NULL,
  display_name text,
  role         text NOT NULL,          -- see §5.3
  idp_subject  text UNIQUE NOT NULL,   -- Zitadel subject
  status       text NOT NULL DEFAULT 'active',
  last_seen_at timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE workspaces (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  name        text NOT NULL,
  slug        citext NOT NULL,
  settings    jsonb NOT NULL DEFAULT '{}',
  archived_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, slug)
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id),
  user_id      uuid NOT NULL REFERENCES users(id),
  role         text NOT NULL,          -- workspace-scoped role
  added_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- ============ Agent identity (critical: agents are principals) ============
CREATE TABLE agents (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  workspace_id   uuid NOT NULL REFERENCES workspaces(id),
  name           text NOT NULL,
  version        int  NOT NULL DEFAULT 1,
  spec_json      jsonb NOT NULL DEFAULT '{}',   -- filled by M4
  owner_user_id  uuid NOT NULL REFERENCES users(id),
  idp_machine_id text NOT NULL,                 -- Zitadel machine user
  status         text NOT NULL DEFAULT 'draft', -- draft|active|suspended|archived
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name, version)
);

-- ============ Secrets / token vault (populated by M2) ============
CREATE TABLE secret_refs (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id),
  purpose    text NOT NULL,        -- connector_oauth | webhook_hmac | ...
  kms_key_id text NOT NULL,
  ciphertext bytea NOT NULL,       -- envelope-encrypted; plaintext never stored
  meta       jsonb NOT NULL DEFAULT '{}',
  rotated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ Entitlements: tiers are DATA, not conditionals (D-09) ============
CREATE TABLE plan_entitlements (
  plan       text PRIMARY KEY,          -- free|pro|business|teams|enterprise
  limits     jsonb NOT NULL,            -- {runs_per_month, connectors, seats, budget_cents}
  exposed    jsonb NOT NULL,            -- {policy_authoring:false, evidence_packs:false, ...}
  -- NOTE: undo and taint defense never appear here. They are not entitlements (D-10).
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ============ Platform events (operational, NOT the audit chain) ============
CREATE TABLE platform_events (
  id         bigserial PRIMARY KEY,
  tenant_id  uuid NOT NULL,
  actor_id   uuid,
  kind       text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

> **Naming discipline:** `platform_events` is operational telemetry. It is **not** the audit chain
> — that lives in the evidence plane (Module 7) and is signed. Never conflate them; an auditor
> asking for the record must never be handed this table.

### 4.1 Row-Level Security

Applied to every tenant-scoped table without exception:

```sql
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;   -- applies to table owner too

CREATE POLICY tenant_isolation ON workspaces
  USING (tenant_id = current_setting('vega.tenant_id')::uuid);
```

Every request sets `vega.tenant_id` in a transaction-local `SET LOCAL` from verified token claims
— **never** from a request parameter. A helper in `packages/db` is the only sanctioned way to open
a connection; a lint rule forbids raw pool access outside it.

### 4.2 Migrations

Drizzle + drizzle-kit. Expand/contract only — a release never contains a destructive migration.
Sequence: add nullable → backfill → application switch → make non-null → drop old (next release).

---

## 5. Backend

### 5.1 Services created

| Service | Namespace | Responsibility |
|---|---|---|
| `services/gateway` | control | Public `/v1` REST, authn, tenant resolution, rate limiting |
| `services/control` | control | tRPC internal API; tenants, users, workspaces, agents |
| `services/execution` | execution | Stub in M1 — health endpoint and plane wiring only |
| `services/evidence` | evidence | Stub in M1 — `/append` endpoint and separate DB connection |

### 5.2 Packages created

| Package | Contents |
|---|---|
| `packages/contracts` | Zod schemas + inferred types shared across all planes |
| `packages/shared` | `brand.ts` (all brand strings — one-file rename, PROJECT.md §3.1), logging, errors, ids |
| `packages/db` | Drizzle client, RLS-scoped connection helper, migrations |
| `packages/authz` | OpenFGA client, `can()` helper, tuple writers |
| `packages/eslint-rules` | The architectural invariant rules (§5.6) |
| `packages/telemetry` | OTel setup, run-id/trace-id correlation |

### 5.3 Role model

| Role | Capabilities |
|---|---|
| `OWNER` | Everything, including billing and tenant deletion |
| `ADMIN` | Users, connectors, policy, budgets. Not billing |
| `COMPLIANCE_OFFICER` | Full audit read, evidence packs, policy read, cannot execute |
| `WORKFLOW_OWNER` | Owns agents; requests autonomy promotion; accountable for a workflow |
| `APPROVER` | Decides approval requests routed to them |
| `MEMBER` | Runs agents within granted scopes |
| `AUDITOR` | **Read-only across the audit plane. Cannot see message bodies unless granted** |

`REGISTERED_PRINCIPAL` is a vertical-specific role added by the beachhead policy pack (M5), not
a core role.

### 5.4 Authorization model (OpenFGA)

```
model
  schema 1.1

type user
type agent
  relations
    define owner: [user]

type workspace
  relations
    define tenant: [tenant]
    define member: [user]
    define admin: [user] or admin from tenant
    define can_run_agent: member or admin
    define can_view_audit: admin or auditor from tenant

type tenant
  relations
    define admin: [user]
    define auditor: [user]
    define compliance: [user]

type document                    # used from M9
  relations
    define viewer: [user, user:*]
    define parent: [workspace]
    define can_read: viewer or member from parent
```

**Why OpenFGA and not SQL checks:** Module 9's ACL-aware retrieval must answer "can this user read
this chunk" across Drive/SharePoint/CRM permission models. That is a relationship graph. Encoding
it in SQL joins does not survive the second connector.

### 5.5 Identity (Zitadel)

- One Zitadel **organization per tenant**; `tenants.idp_org_id` is the link.
- Human users: OIDC. Enterprise adds SAML and SCIM provisioning (M10 completes SCIM).
- **Agents are machine users.** Each agent gets a Zitadel machine identity; runs receive a
  short-lived (≤15 min), scope-limited token minted per run. There is no long-lived agent
  credential anywhere in the system.
- Every action recorded downstream carries **both** `agent_id` and `on_behalf_of_user_id`.

### 5.6 Architectural lint rules

Shipped in `packages/eslint-rules`; failing any is a build error, not a warning.

| Rule | Enforces |
|---|---|
| `no-evidence-write-from-execution` | Invariant 1 — evidence write client importable only via the append interface |
| `no-raw-db-pool` | RLS — connections only through `packages/db` scoped helper |
| `no-eval` | Invariant on sandboxing — no `eval`/`new Function`/`vm` outside `packages/taint` |
| `require-tenant-context` | Every control/execution service handler resolves tenant before data access |
| `no-untrusted-in-privileged` | Stub in M1; enforced fully in M3 |
| `require-tool-declaration` | Stub in M1; enforced fully in M2 |

Writing the stubs now means M2 and M3 turn them on rather than introducing them.

---

## 6. Frontend

### 6.1 App shell

Next.js App Router. Route groups mirror PROJECT.md §6 surfaces:

```
app/
├─ (auth)/            login, callback, org-select
├─ (app)/
│  ├─ chat/           Conversational surface        [stub]
│  ├─ action-center/  Executive brief, tasks, security, usage, autonomy  [stub]
│  ├─ approvals/      Approval inbox                [stub]
│  ├─ audit/          Audit explorer                [stub]
│  ├─ studio/         Agent studio                  [stub]
│  └─ admin/          Admin & policy console        [partial — real in M1]
└─ api/               BFF route handlers
```

Each stub renders a real, styled empty state naming the module that fills it. Stubs are not
`TODO` pages — a design partner sees this shell.

### 6.2 Built for real in M1

**Admin console**, the only fully working surface:

- Tenant settings: name, region, retention (with the 180-day floor enforced in the UI and API)
- Users: invite, role assignment, deactivate, SSO status
- Workspaces: create, rename, membership, archive
- Agents: list, create shell, ownership assignment (spec editing arrives in M4)
- Session and security: active sessions, SSO configuration

### 6.3 Design system

| Concern | Decision |
|---|---|
| Components | shadcn/ui (copy-in, Radix primitives) |
| Styling | Tailwind; semantic tokens only — no raw hex in components |
| Theme | Light + dark; tokens defined on `:root`, redefined under `prefers-color-scheme` and `[data-theme]` |
| Density | Compact default — approval queues and audit tables are the dominant surfaces |
| Data fetching | TanStack Query; server components for large tables |
| Forms | React Hook Form + the same Zod schemas the API validates with |

**Risk-tier color semantics, defined once here and used everywhere after:**

| Tier | Token | Usage |
|---|---|---|
| Low | `--risk-low` (neutral) | Auto-executed |
| Medium | `--risk-medium` (amber) | Held for review |
| High | `--risk-high` (orange) | Requires approval |
| Critical | `--risk-critical` (red) | Blocked / dual auth |

Never encode tier by color alone — always pair with a label and icon (accessibility, and these
screens get printed into compliance evidence).

---

## 7. APIs

### 7.1 Public REST (`/v1`, Fastify)

```
POST   /v1/auth/token                  # OIDC code exchange
POST   /v1/auth/refresh
GET    /v1/me                          # identity + roles + tenant

GET    /v1/tenants/current
PATCH  /v1/tenants/current             # name, retention, settings (ADMIN)

GET    /v1/users
POST   /v1/users/invite
PATCH  /v1/users/:id                   # role, status
DELETE /v1/users/:id

GET    /v1/workspaces
POST   /v1/workspaces
PATCH  /v1/workspaces/:id
POST   /v1/workspaces/:id/members
DELETE /v1/workspaces/:id/members/:userId

GET    /v1/agents
POST   /v1/agents                      # creates Zitadel machine identity
PATCH  /v1/agents/:id
DELETE /v1/agents/:id

GET    /healthz  /readyz  /metrics
```

### 7.2 Conventions (set here, obeyed by every later module)

| Concern | Rule |
|---|---|
| Idempotency | Every mutating endpoint accepts `Idempotency-Key`; stored 24h |
| Errors | RFC 9457 Problem Details; stable `type` URIs |
| Pagination | Cursor-based, `?cursor=&limit=`; never offset on audit tables |
| Versioning | Path-versioned `/v1`; additive changes only within a version |
| Rate limits | Per tenant and per token; `429` with `Retry-After` |
| Tracing | `traceparent` in, `x-vega-run-id` out where applicable |

---

## 8. Key Flows

### 8.1 Sign-in and tenant resolution

```
Browser → /login → Zitadel OIDC → callback with code
  → gateway exchanges code, validates ID token
  → resolve users.idp_subject → user + tenant
  → mint session (httpOnly, SameSite=Lax, short TTL + refresh)
  → every subsequent request: verify session → SET LOCAL vega.tenant_id → handler
```

**Invariant:** `tenant_id` originates only from verified token claims. A lint rule and a
code-review checklist item forbid reading it from a header, query, or body.

### 8.2 Agent creation

```
ADMIN creates agent
  → control service creates Zitadel machine user
  → agents row written with idp_machine_id
  → OpenFGA tuple: agent#owner@user:<owner>
  → platform_event emitted
  → agent status = draft   (cannot run until M4 gives it a spec)
```

---

## 9. Technology

Per TECHSTACK.md §4–§7, §12, §17, §19–§21.

| Concern | Choice | License |
|---|---|---|
| Runtime | Node 22 LTS, TypeScript 5.x | MIT / Apache-2.0 |
| Monorepo | pnpm workspaces + Turborepo | MIT / MPL-2.0 |
| Web | Next.js, React 19, Tailwind, shadcn/ui | MIT |
| API | Fastify + tRPC + Zod | MIT |
| DB | PostgreSQL 16, Drizzle ORM | PostgreSQL / Apache-2.0 |
| Identity | Zitadel | Apache-2.0 |
| Authorization | OpenFGA | Apache-2.0 |
| Secrets | OpenBao + External Secrets Operator | MPL-2.0 / Apache-2.0 |
| Observability | OpenTelemetry + SigNoz (ClickHouse) | Apache-2.0 / MIT |
| Orchestration | Kubernetes, Helm, Argo CD, Cilium | Apache-2.0 |
| IaC | OpenTofu | MPL-2.0 |
| CI | GitHub Actions | hosted |

---

## 10. Security

| Control | Implementation |
|---|---|
| Tenant isolation | Postgres RLS with `FORCE`, verified by adversarial test |
| Session security | httpOnly + Secure + SameSite cookies; short TTL; refresh rotation |
| Agent credentials | Per-run, ≤15 min, scope-limited. No long-lived agent tokens |
| Secret storage | Envelope encryption; plaintext never touches Postgres |
| Plane separation | Cilium default-deny + separate DB credentials + separate KMS keys |
| Transport | mTLS between namespaces; TLS 1.3 externally; HSTS |
| Headers | CSP, X-Frame-Options DENY, Referrer-Policy, Permissions-Policy |
| Supply chain | Trivy + OSV-Scanner + Semgrep in CI; SBOM via Syft; cosign-signed images |
| Audit of admin actions | `platform_events` now; upgraded to signed chain entries in M7 |

---

## 11. Testing

| Suite | Tool | Gate |
|---|---|---|
| Unit | Vitest | Blocking |
| Integration | Vitest + Testcontainers (Postgres, Zitadel, OpenFGA) | Blocking |
| **Tenant isolation** | Custom adversarial suite (§11.2) | **Blocking** |
| Authorization | OpenFGA assertion tests | Blocking |
| E2E | Playwright — sign in, invite, workspace, agent | Blocking |
| Lint rules | Fixture tests for each custom rule | Blocking |
| **Plane separation policy** | Network + IAM policy test (§11.4) | **Blocking** |
| Security scan | Trivy, Semgrep, OSV | Blocking on high |

### 11.2 Tenant isolation suite

Not optional and not a single test. For every tenant-scoped table:

1. Seed two tenants with identical-shaped data.
2. Open a connection as tenant A; attempt read, update, and delete of every tenant B row by id.
3. Assert zero rows returned and zero rows affected — for every table, every operation.
4. Assert the same through the public API with a valid tenant-A token and tenant-B identifiers.
5. Assert `SET LOCAL` cannot be overridden by a request-supplied value.

This suite grows automatically: a table added without an isolation test fails a schema-coverage
check.

### 11.4 Plane separation policy test

Runs against the deployed cluster in CI:

- Assert the execution service account has **no** credential for `vega-evidence` DB.
- Assert a pod in `vega-execution` cannot open a TCP connection to the evidence DB.
- Assert `vega-evidence` cannot initiate a connection to `vega-execution`.
- Assert the execution service account cannot use the evidence signing key in KMS.

A failure here is a P0. This is the control, not the application code.

---

## 12. Observability

- OTel traces from browser → gateway → control → execution.
- **`trace_id` correlates with `run_id` from M4 and audit `seq` from M7.** Establish the
  convention now: every log line carries `tenant_id`, `trace_id`, and — once they exist —
  `run_id` and `action_id`.
- Dashboards: request rate/latency/error by endpoint and tenant; auth failures; RLS denials
  (should be zero in production — a non-zero rate is a bug or an attack).
- Alerts: auth failure spike, RLS denial > 0, DB connection saturation, plane-policy drift.

---

## 13. Acceptance Criteria

- [ ] Cold clone → `pnpm install && pnpm dev` brings the full local stack up in under 5 minutes
- [ ] A user signs in via Zitadel, lands in their tenant, and sees all six surfaces
- [ ] Admin can invite a user, assign a role, create a workspace, and create an agent
- [ ] Creating an agent provisions a distinct machine identity in Zitadel
- [ ] Tenant isolation suite passes for 100% of tenant-scoped tables, API included
- [ ] Plane separation policy test passes against a deployed cluster
- [ ] All six lint rules exist; violating fixtures fail the build
- [ ] Traces flow end to end and are visible in SigNoz with tenant correlation
- [ ] `brand.ts` is the only file containing the product name (verified by grep in CI)
- [ ] Helm chart deploys the four namespaces with default-deny policies
- [ ] Self-serve signup provisions tenant + workspace and reaches a first run in under 5 minutes
- [ ] Entitlements are data-driven; adding a plan requires no code change
- [ ] No business-logic branch anywhere keys off `tenants.plan` (lint rule + review checklist)

---

## 14. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Zitadel multi-tenancy modeling proves awkward | Weeks lost | Spike org-per-tenant in week 1; Keycloak is the fallback (TECHSTACK §12) |
| RLS retrofitted "just for this query" | Isolation breach | `no-raw-db-pool` lint rule + coverage check |
| Plane separation treated as a diagram, not a control | Audit chain worthless later | Policy test blocking in CI from M1 |
| Over-engineering the shell before there is a user | Phase 1 overruns | Stubs stay stubs; only admin is real |
| Docker Desktop licensing as the team grows | Legal/cost | Podman Desktop is the documented default |

---

## 15. Deliverables

- [ ] Monorepo with `apps/`, `services/`, `packages/`, `infra/`, `evals/` per TECHSTACK §17
- [ ] `packages/contracts`, `shared` (with `brand.ts`), `db`, `authz`, `telemetry`, `eslint-rules`
- [ ] Migrations for all §4 tables with RLS enabled and forced
- [ ] Zitadel + OpenFGA provisioned via OpenTofu, model checked in
- [ ] `services/gateway`, `services/control` live; `execution` and `evidence` stubs deployed
- [ ] Next.js shell with six routes; admin console fully functional
- [ ] Helm chart, four namespaces, Cilium policies, mTLS, Argo CD app
- [ ] `docker-compose.yml` local stack
- [ ] CI pipeline with the §11 gates wired (later gates stubbed as no-ops that fail loudly if removed)
- [ ] `CONTRIBUTING.md` documenting the invariants and the dependency-addition checklist
      (TECHSTACK Appendix B)

---

## 16. Notes for the Next Module

Module 2 turns on `require-tool-declaration` and consumes `secret_refs` for OAuth token storage.
Leave the token vault helper in `packages/shared/crypto` with envelope encryption implemented and
tested, even though nothing writes to it yet — M2 should not have to build crypto under deadline.
