# Module 1 — Implementation Plan

> Executable plan for [module1.md](module1.md). Nine steps, dependency-ordered. Each step has a
> definition of done you can actually check.

**Estimate:** 5–7 engineer-weeks solo · 3–4 weeks with two engineers
**Prerequisite:** none. This is the first code in the project.

---

## How to use this

Steps are ordered so that **each one is verifiable before the next begins**. Do not parallelise
past a step whose DoD is unmet — steps 2, 3, and 8 all enforce invariants that later steps assume.

Track progress in the checkboxes. When a step's DoD is met, commit it.

---

## Step 0 — Before you write code (½ day)

- [ ] `cp .env.example .env`
- [ ] Generate the two local secrets:
      ```bash
      openssl rand -base64 48   # -> SESSION_SECRET
      openssl rand -base64 32   # -> LOCAL_KEK_BASE64
      ```
- [ ] `pnpm install`
- [ ] `pnpm stack:up` — first run pulls images, allow ~5 minutes
- [ ] Confirm: Postgres `:5432`, evidence Postgres `:5433`, Valkey `:6379`,
      Zitadel `:8080`, OpenFGA `:8081`, Jaeger UI `:16686`

**DoD:** every container healthy (`docker compose ps`), Zitadel console loads at
`http://localhost:8080` (admin / `Password1!`).

> **No external accounts are needed for Module 1.** Everything above is self-hosted. The first
> account you need is Google Cloud, in Module 2 — but see §"Start these now" below, because OAuth
> verification is calendar time, not engineering time.

---

## Step 1 — Workspace skeleton compiles ✅ COMPLETE

- [x] `packages/shared` — `brand.ts`, `errors.ts`, `ids.ts`, `logging.ts` (pino with redaction)
- [x] `packages/contracts` — Zod schemas for `Tenant`, `User`, `Workspace`, `Agent`, `Role`,
      `Plan`, entitlements, and the Problem Details envelope
- [x] `packages/telemetry` — OTel init, trace-id correlation helper, tenant span attributes
- [x] Task graph wired; `typecheck`, `lint`, `test` green across 21 packages
- [x] 26 tests passing, including redaction and the D-10 entitlement guard

**DoD met:** `pnpm install && pnpm typecheck && pnpm lint && pnpm test` all green from cold.

### Decisions taken during Step 1

| Decision | Why |
|---|---|
| **Task runner is a single root `tsc` project, not Turborepo** | On this machine pnpm is an npm-global shim, which turbo cannot resolve (`cannot find binary path`), and nested `pnpm` calls inside scripts fail the same way. One root project also typechecks 21 packages faster than 21 `tsc` processes. `turbo.json` is retained for when caching is needed — revisit on WSL2/CI. |
| **OpenTelemetry 2.x, not 1.30** | `^1.30.0` resolved to the pre-2.0 API (`new Resource()` + `addSpanProcessor`). 2.x is current in 2026 and has the `resourceFromAttributes` / `spanProcessors` API. |
| **Taint, reversibility, and risk-tier enums deliberately NOT defined** | They belong to the modules that own their semantics (M3, M2/M6, M5). Inventing them now invites a definition that does not survive contact with the spec. |
| **`createLogger` takes an optional destination** | Needed to assert redaction in tests. A security property nobody tests is a security property nobody has. |

**Watch for:** `packages/contracts` is imported by every plane. Treat it as a published API from
day one — additive changes only.

---

## Step 2 — Database with RLS ✅ COMPLETE ⚠ invariant step

The single most important step in the module. Everything downstream assumes it.

- [x] `packages/db` — Drizzle client, hand-written SQL migrations, migration runner
- [x] Schema for `tenants`, `users`, `workspaces`, `workspace_members`, `agents`,
      `plan_entitlements`, `secret_refs`, `platform_events` (module1.md §4)
- [x] **RLS enabled AND forced** on every tenant-scoped table:
      ```sql
      ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
      ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON <t>
        USING (tenant_id = current_setting('vega.tenant_id')::uuid);
      ```
- [x] `withTenant(tenantId, fn)` helper — transaction + parameterised `set_config`
- [x] Envelope encryption in `packages/shared/src/crypto.ts` (AES-256-GCM, DEK wrapped by KEK)
- [x] Seed script: 2 tenants with identically-shaped data

**DoD met — 45 database tests pass, and the suite is proven to fail when RLS is weakened.**

```bash
pnpm --filter @vega/db test:isolation
```

### What the suite actually asserts

For **every** tenant-scoped table, as tenant A holding tenant B's exact primary keys:
SELECT → 0 rows · UPDATE → 0 rows affected · DELETE → 0 rows affected · unqualified SELECT
returns only tenant A. Plus write-side isolation (INSERT and re-parent into another tenant are
both rejected), fail-closed behaviour with no context, transaction-local context that does not
leak across pooled connections, and a coverage test that fails when **any** table exists without
RLS enabled, forced, and carrying both USING and WITH CHECK.

### Mutation-tested

A suite that cannot fail is worthless, so both weakenings were verified to be caught:

| Mutation | Result |
|---|---|
| `ALTER TABLE users NO FORCE ROW LEVEL SECURITY` | ❌ caught — *"users: RLS not FORCED (the owner would bypass it)"* |
| `DROP POLICY tenant_isolation ON agents` | ❌ caught by the coverage test |

Also verified from a **destroyed volume**: migrations alone rebuild a correctly isolated schema.

### Decisions taken during Step 2

| Decision | Why |
|---|---|
| **Hand-written SQL migrations, not drizzle-kit generate** | RLS policies, roles, and grants are the substance of this step and are not expressible in a schema DSL. A security reviewer reads SQL. Drizzle remains the typed query layer; `coverage.test.ts` guards drift in the direction that matters. |
| **`set_config($1, $2, true)` rather than `SET LOCAL`** | `SET LOCAL` cannot take a bind parameter — it would mean interpolating a tenant id into SQL text. `set_config` is parameterised, so a hostile id is a value that fails to cast, never syntax. |
| **`tenant_id` denormalised onto `workspace_members`** | module1.md §4 models it as `(workspace_id, user_id)` only. An RLS policy that reaches through a join is slower and easier to get wrong; a composite FK keeps the denormalised column honest. |
| **A malformed context raises rather than returning zero rows** | It can only happen if something bypassed `withTenant`, and that is a bug worth surfacing. Still fail-closed: the statement aborts and returns nothing. |
| **`assertNotSuperuser()` at startup** | PostgreSQL bypasses RLS for superusers *even with FORCE*. An app running as `postgres` has perfect-looking policies and zero isolation, and tests connecting the same way all pass. |
| **`plan_entitlements` has RLS with a read-all policy** | Global reference data, but giving it a policy means the coverage test needs no special case, and the app holds no write grant on it. |

**Watch for:** the temptation to bypass `withTenant` "just for this admin query." That is how
isolation breaks. `DB-001` in `scripts/verify-invariants.mjs` exists to catch it, and
`withSystemBypassingRls` is named to be uncomfortable to type.

---

## Step 3 — Identity: Zitadel ✅ COMPLETE

- [x] Project + WEB application (private_key_jwt + PKCE) — **automated** by `pnpm idp:bootstrap`
      (`scripts/zitadel-bootstrap.ts`) instead of console clicks; idempotent
- [x] Provisioner service account (IAM_OWNER) + key → `infra/docker/secrets/zitadel-sa.json` (gitignored)
- [x] OIDC code + PKCE flow in `services/gateway`; session cookie httpOnly + Secure + SameSite=Lax,
      short TTL with refresh rotation and token-reuse detection
- [x] **Tenant resolution:** `users.idp_subject` → user → tenant, via `auth_resolve_subject()` on a
      verified `sub` only. Headers, query and body are ignored (asserted in `gateway.test.ts`)
- [x] **Agent identities:** each agent is a distinct Zitadel machine user in the tenant's org.
      Per-run tokens: `RunTokenIssuer`, ES256, ≤15 min enforced at mint **and** verify, exact scopes

**DoD verified against live Zitadel v4.19:** browser sign-in through the Zitadel login UI →
`GET /v1/me` returns identity + role + tenant → `POST /v1/agents` produces a machine user visible in
Zitadel, owned by the tenant's organization.

### Decisions taken during Step 3

| Decision | Why |
|---|---|
| **Pre-tenant lookups via SECURITY DEFINER functions owned by a NOLOGIN role** | Sign-in and session lookup happen before a tenant is known. `withSystemBypassingRls` would hand every request an unisolated connection; `vega_auth` holds a role-scoped SELECT policy on exactly the columns resolution needs, and the app role can only EXECUTE the two functions (`resolver.test.ts`). |
| **Opaque session tokens, SHA-256 at rest, rotation with a 30 s grace window** | A DB read yields nothing presentable. A rotated-away token presented after the grace window revokes the whole session (stolen-token signal). |
| **Gateway→control identity is a signed 60 s principal assertion (ES256)** | "Tenant context only from verified claims" has to survive the plane hop. Control holds only the public key (fetched from `/.well-known/jwks.json`), so it can verify but never mint. |
| **Invite creates the Zitadel user immediately; status flips to `active` on first sign-in** | The IdP subject is known at invite time, so first sign-in needs no email matching across tenants. |
| **Signup runs as a `system: signup` principal admitted to one procedure** | Provisioning precedes any user or tenant. The system principal is refused by every other procedure. |

---

## Step 4 — Authorization: OpenFGA ✅ COMPLETE

- [x] Model in `packages/authz/model/model.fga` (checked-in DSL; JSON derived at load time)
- [x] Store + model created by provisioning (dev: control creates one if `OPENFGA_STORE_ID` is unset)
- [x] `packages/authz` — fetch-based client, `check`, `batchCheck` (errors count as denials), tuple writers
- [x] Tuple lifecycle: grants write the DB first, revocations delete tuples first — both fail closed
- [x] Role model from module1.md §5.3 as a capability matrix; `tenant.non_executor` makes
      COMPLIANCE_OFFICER and AUDITOR unable to execute even when added to a workspace

**DoD:** 44 assertion tests against a real OpenFGA, every role × relation, including a member of A
cannot `can_run_agent` in B. ✅

---

## Step 5 — API surface ✅ COMPLETE

- [x] `services/gateway` (Fastify): public `/v1`, authn, tenant resolution, rate limiting
- [x] `services/control` (tRPC): tenants, users, workspaces, agents, signup
- [x] `services/execution` + `services/evidence`: health endpoints and plane wiring
      (execution → evidence only via HTTP `/append`; evidence DB INSERT-only + append-only trigger)
- [x] Endpoints from module1.md §7.1, plus `/v1/sessions` for the admin console
- [x] Conventions: `Idempotency-Key` (24 h, per tenant+principal, claimed before execution),
      RFC 9457 everywhere, cursor pagination, `/v1`, per-tenant **and** per-token limits (Valkey),
      `traceparent` in / `x-trace-id` out, security headers
- [x] Entitlement checks read `plan_entitlements` — they gate the sharing *surface*, never logic

**DoD:** OpenAPI generated from the Zod schemas (`/v1/openapi.json`, `/docs`); a procedure reached
without a principal returns `tenant-context-missing` (500); double-POST with one idempotency key
produces one effect. ✅

## Step 6 — Web shell (5–6 days)

- [ ] Next.js App Router with the six route groups; five render **styled empty states naming the
      module that fills them** — not `TODO` pages, a design partner sees this
- [ ] Tailwind + shadcn/ui; semantic tokens only, no raw hex in components
- [ ] Light + dark themes
- [ ] **Risk-tier tokens defined once here** (`--risk-low/medium/high/critical`) and used
      everywhere after. Never color alone — always paired with a label and icon, because these
      screens end up printed in compliance evidence
- [ ] **Admin console fully working:** tenant settings (retention floor 180 days enforced in UI
      *and* API), users (invite / role / deactivate), workspaces, agents (list/create/ownership),
      sessions

**DoD:** sign in → land in tenant → all six surfaces reachable → complete an invite-to-agent-create
flow without touching the database.

---

## Step 7 — Self-serve signup ✅ COMPLETE

- [x] `POST /v1/signup` → Zitadel org + owner + tenant + default workspace + tuples, all-or-nothing by
      compensation → connector-authorize stub → first-run stub
- [x] `plan_entitlements` seeded for all five plans by migration `0003_entitlements.sql`
- [x] Plan changes are data: the same `provisionTenant()` runs for every plan

**DoD:** a brand-new email reaches a provisioned, usable workspace in seconds (`gateway.test.ts`,
and verified live against Zitadel). ✅

---

## Step 8 — Plane separation (3–4 days) ⚠ invariant step

Application code cannot enforce this. Infrastructure must.

- [ ] Helm chart: four namespaces — `vega-experience`, `vega-control`, `vega-execution`,
      `vega-evidence`
- [ ] Cilium **default-deny** in every namespace; explicit allows only (module1.md §3.1)
- [ ] Separate DB credentials; execution plane holds **no** credential for the evidence DB
- [ ] mTLS between namespaces (cert-manager)
- [ ] OpenTofu for Zitadel + OpenFGA provisioning; model checked in
- [ ] Argo CD application

**DoD — the policy test passes against a deployed cluster:**

- execution service account has no evidence-DB credential
- a pod in `vega-execution` cannot open TCP to the evidence DB
- `vega-evidence` cannot initiate a connection to `vega-execution`
- execution cannot use the evidence signing key in KMS

**A failure here is P0.** This is the control; the code is not.

---

## Step 9 — CI gates + invariant enforcement (2–3 days)

- [ ] `packages/eslint-rules` with all six rules from module1.md §5.6 (two are stubs that M2/M3
      turn on — ship the stubs so later modules *enable* rather than *introduce* them)
- [ ] Fixture tests per rule: a violating fixture must fail the build
- [ ] `scripts/verify-invariants.mjs` wired into CI (already scaffolded)
- [ ] Full pipeline: lint → typecheck → invariants → unit → integration → **tenant-isolation** →
      e2e → security scan
- [ ] Playwright: sign in, invite, workspace, agent create
- [ ] Later-module gates present but disabled — visibly missing, not silently absent

**DoD:** a PR violating any invariant fails CI with a message naming the invariant and its
PROJECT.md reference.

---

## Module 1 exit criteria

Copied from module1.md §13. All must hold:

- [ ] Cold clone → `pnpm install && pnpm dev` → full stack in under 5 minutes
- [ ] Sign in via Zitadel, land in tenant, see all six surfaces
- [ ] Admin can invite a user, assign a role, create a workspace, create an agent
- [ ] Creating an agent provisions a distinct machine identity
- [ ] Tenant isolation suite passes for 100% of tenant-scoped tables, API included
- [ ] Plane separation policy test passes against a deployed cluster
- [ ] All six lint rules exist; violating fixtures fail the build
- [ ] Traces flow end to end in Jaeger with tenant correlation
- [ ] `brand.ts` is the only file containing the product name (CI-verified)
- [ ] Helm chart deploys four namespaces with default-deny
- [ ] Self-serve signup reaches a first run in under 5 minutes
- [ ] Entitlements are data-driven; adding a plan requires no code change
- [ ] No business-logic branch keys off `tenants.plan`

---

## Sequencing notes

**Do steps 2 and 8 properly or not at all.** RLS and plane separation are the two things in this
module that cannot be retrofitted. Everything else can be improved later; these two get harder
every week they are deferred.

**Step 7 looks premature and is not.** Self-serve provisioning touches the tenant lifecycle, which
every module depends on. Adding it in month nine means reworking the foundation under nine modules
of code.

**Leave the loud warnings in.** Later modules replace permissive defaults; until then the logs
should say the system is ungoverned on every step. Silence here is how an ungoverned deployment
reaches a customer.

---

## Start these now — they are calendar time, not engineering time

Begin in week 1 of Module 1, even though they belong to later modules:

| Item | Why now | Lead time |
|---|---|---|
| **Google Cloud OAuth app verification** | Gmail restricted scopes need verification; blocks the M2 pilot | Weeks |
| **Microsoft Entra app registration** | Same shape | Days–weeks |
| **Trademark knockout search** | Blocks any public artifact, and `brand.ts` exists to make the rename cheap | Weeks |
| **Design partner conversation** | Phase 1 is gated on one signed design partner (PROJECT.md §19) | Weeks–months |
| **Anthropic API key** | Needed at M3; free to obtain now | Minutes |

---

## What Module 1 deliberately does not do

No agent execution, no connectors, no policy evaluation, no LLM call anywhere. If you find
yourself reaching for an Anthropic key in this module, you have left scope.

The output of Module 1 is **a running, deployable, empty product** — with a tenancy boundary, a
plane separation, and build-time invariant enforcement that are real from this point on.
