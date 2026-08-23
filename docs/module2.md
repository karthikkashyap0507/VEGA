# Module 2 — Connector Framework & Tool Layer

> Every way VEGA touches the outside world. The tool declaration contract defined here is what
> makes reversibility (M6), proof (M7), and taint gating (M3) possible at all — a tool without a
> complete declaration cannot exist in this system.

| | |
|---|---|
| **Phase** | 1 (months 3–4) |
| **Covers** | P3 (Connector Framework), C5 tool surface, PROJECT.md §7.5, §9.3 |
| **Depends on** | M1 (tenancy, secret vault, identity) |
| **Blocks** | M3 (taint labels at source), M4 (execution), M6 (compensators), M7 (receipts) |
| **Estimate** | 6–8 engineer-weeks |

---

## 1. Purpose & Scope

### 1.1 What this module delivers

A connector framework plus the launch connector set, where every action a connector exposes
carries a machine-readable declaration of its scopes, egress class, reversibility class, maximum
tolerable input taint, and idempotency semantics — and a `simulate()` implementation.

After this module, a developer can call `tools.gmail.send.simulate(args)` and get an accurate
blast radius without sending anything.

### 1.2 Why the declaration is the centerpiece

Three later modules are impossible without it:

| Module | Needs from the declaration |
|---|---|
| M3 (taint) | `max_taint` and `egress_class` — the gate condition |
| M6 (reversibility) | `reversibility` and `compensator` — what undo even means |
| M7 (evidence) | Everything — the receipt records the declared properties in force |
| M5 (risk) | `egress_class`, `reversibility`, `sensitivity_hint` — three of six risk inputs |

This is why `require-tool-declaration` is a **build error**, not a lint warning. A tool that
registers without one silently defeats the product.

### 1.3 In scope

- `ToolDeclaration` contract, registry, and build-time validation
- Connector SDK: auth lifecycle, rate limiting, retry/backoff, idempotency, error normalization
- `simulate()` contract and per-tool implementations
- OAuth broker with scope minimization and a consent transparency screen
- Token vault (envelope encryption via M1's `secret_refs`), refresh, revocation
- Launch connectors: Gmail, Google Calendar, Google Drive, Outlook/Exchange, SharePoint, Slack,
  web fetch, generic HTTP
- MCP server/client compatibility so third-party tool servers attach
- Connector health monitoring and certification checklist
- Frontend: connector gallery, authorize flow, consent screen, health dashboard, scope viewer

### 1.4 Out of scope

Compensator *implementations* (M6 — the interface is defined here, the inverses are written
there) · taint propagation (M3 — labels are assigned here, propagation happens there) · planning
or invocation (M4) · knowledge-base ingestion (M9).

---

## 2. Dependencies

**Upstream (M1):** tenancy + RLS, `secret_refs` vault with envelope encryption, agent machine
identities, OpenBao/KMS, `require-tool-declaration` lint stub.

**Downstream contract — the freeze point.** `ToolDeclaration` is imported by M3, M4, M5, M6, and
M7. Treat it as a published API from the day this module merges: additive changes only, versioned
in `packages/contracts`.

---

## 3. Architecture

```
      control plane                          execution plane
┌──────────────────────┐            ┌────────────────────────────────────┐
│ Tool Registry (read) │◀───────────│  Connector Runtime                 │
│ declarations, scopes │            │  ┌──────────────────────────────┐  │
└──────────────────────┘            │  │ Connector SDK                │  │
                                    │  │ auth · retry · ratelimit ·   │  │
┌──────────────────────┐            │  │ idempotency · normalize      │  │
│ OAuth Broker         │───tokens──▶│  └──────────────────────────────┘  │
│ consent · refresh    │            │     │ gmail  calendar  drive       │
└──────────────────────┘            │     │ outlook sharepoint slack     │
        │                           │     │ web-fetch (isolated) http    │
        ▼                           └─────┼──────────────────────────────┘
  secret_refs (M1)                        ▼
  envelope-encrypted                external provider APIs
```

**Web fetch is deliberately drawn outside the trusted set.** It runs in its own network-isolated
pod with no credentials mounted (§10.3).

---

## 4. Data Model

```sql
-- ============ Connector instances (a tenant's authorized connection) ============
CREATE TABLE connectors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id),
  workspace_id   uuid REFERENCES workspaces(id),   -- null = tenant-wide
  kind           text NOT NULL,                    -- gmail|gcal|gdrive|outlook|sharepoint|slack|web|http
  display_name   text NOT NULL,
  account_ref    text NOT NULL,                    -- provider account identifier
  owner_user_id  uuid NOT NULL REFERENCES users(id),
  scopes_granted text[] NOT NULL,
  scopes_required text[] NOT NULL,                 -- what we asked for, for the consent screen
  secret_ref_id  uuid REFERENCES secret_refs(id),
  status         text NOT NULL DEFAULT 'pending',  -- pending|active|degraded|expired|revoked
  health_json    jsonb NOT NULL DEFAULT '{}',
  last_ok_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, account_ref)
);

-- ============ Tool declarations (versioned, immutable per version) ============
CREATE TABLE tool_declarations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_kind     text NOT NULL,
  tool_id            text NOT NULL,                -- 'gmail.send'
  version            int  NOT NULL,
  scopes             text[] NOT NULL,
  egress_class       text NOT NULL,                -- INTERNAL|EXTERNAL|PUBLIC
  reversibility      text NOT NULL,                -- R0|R1|R2|R3
  max_taint          text NOT NULL,                -- TRUSTED|ORG|UNTRUSTED
  idempotency        text NOT NULL,                -- NATIVE|KEYED|NONE
  sensitivity_hint   int  NOT NULL DEFAULT 0,      -- 0-100, risk input
  hold_supported     boolean NOT NULL DEFAULT false,
  simulate_supported boolean NOT NULL DEFAULT false,
  compensator_ref    text,                         -- required unless R0 or R3
  args_schema        jsonb NOT NULL,               -- JSON Schema from Zod
  effect_schema      jsonb NOT NULL,               -- shape of simulate()/execute() effect
  cost_hint          jsonb,
  certified_at       timestamptz,                  -- §12 checklist passed
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_kind, tool_id, version),
  CONSTRAINT compensator_required
    CHECK (reversibility IN ('R0','R3') OR compensator_ref IS NOT NULL)
);

-- ============ Idempotency ============
CREATE TABLE tool_invocations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  connector_id     uuid NOT NULL REFERENCES connectors(id),
  tool_id          text NOT NULL,
  idempotency_key  text NOT NULL,
  args_digest      text NOT NULL,
  state            text NOT NULL,                  -- in_flight|succeeded|failed
  response_ref     text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  UNIQUE (tenant_id, tool_id, idempotency_key)
);

-- ============ Rate limit + health telemetry ============
CREATE TABLE connector_events (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  connector_id uuid NOT NULL,
  kind         text NOT NULL,     -- auth_refreshed|rate_limited|error|revoked|scope_changed
  detail       jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

> `tool_declarations` rows are **generated from code** at build time and inserted by migration —
> never hand-edited. The TypeScript declaration is the source of truth; the table is a queryable
> projection for the control plane and the risk engine.

---

## 5. Backend

### 5.1 The declaration contract

```ts
// packages/contracts/src/tools.ts  — FROZEN API from this module onward
export interface ToolDeclaration<A extends ZodTypeAny, E extends ZodTypeAny> {
  toolId: string;                       // 'gmail.send'
  connectorKind: ConnectorKind;
  version: number;

  scopes: string[];                     // minimum OAuth scopes actually required
  egressClass: 'INTERNAL' | 'EXTERNAL' | 'PUBLIC';
  reversibility: 'R0' | 'R1' | 'R2' | 'R3';
  maxTaint: 'TRUSTED' | 'ORG' | 'UNTRUSTED';
  idempotency: 'NATIVE' | 'KEYED' | 'NONE';
  sensitivityHint: number;              // 0-100

  holdSupported: boolean;
  argsSchema: A;
  effectSchema: E;

  simulate(args: z.infer<A>, ctx: ToolContext): Promise<Effect<z.infer<E>>>;
  execute (args: z.infer<A>, ctx: ToolContext): Promise<Result<z.infer<E>>>;

  compensatorRef?: string;              // resolved in M6; presence enforced by type + CHECK
  costHint?: { unit: string; estimate: number };
}
```

**Type-level enforcement.** `registerTool()` accepts a discriminated union where `R1` and `R2`
variants *require* `compensatorRef`. An `R1` tool without one does not typecheck — the database
CHECK constraint is the second line of defense, not the first.

### 5.2 Launch connector declarations

| Tool | Egress | Rev. | Max taint | Idempotency | Hold | Notes |
|---|---|---|---|---|---|---|
| `gmail.search` | INTERNAL | R0 | UNTRUSTED | NATIVE | – | Results are `UNTRUSTED` |
| `gmail.read` | INTERNAL | R0 | UNTRUSTED | NATIVE | – | Body is always `UNTRUSTED` |
| `gmail.draft` | INTERNAL | R1 | UNTRUSTED | KEYED | – | Compensator: delete draft |
| `gmail.send` | **EXTERNAL** | **R2** | **TRUSTED** | KEYED | ✅ | Recipient must be `TRUSTED` |
| `gmail.label` | INTERNAL | R1 | ORG | KEYED | – | Compensator: remove label |
| `gcal.list` | INTERNAL | R0 | ORG | NATIVE | – | |
| `gcal.create` | EXTERNAL | R1 | ORG | KEYED | ✅ | Compensator: delete + notify |
| `gcal.update` | EXTERNAL | R1 | ORG | KEYED | ✅ | Compensator: restore snapshot |
| `gcal.delete` | EXTERNAL | R1 | ORG | KEYED | ✅ | Compensator: recreate from snapshot |
| `gdrive.read` | INTERNAL | R0 | UNTRUSTED | NATIVE | – | |
| `gdrive.write` | INTERNAL | R1 | ORG | KEYED | – | Compensator: restore prior revision |
| `gdrive.share` | **EXTERNAL** | R1 | **TRUSTED** | KEYED | ✅ | Compensator: revoke permission |
| `slack.post` | EXTERNAL | R2 | TRUSTED | KEYED | ✅ | Delete works but is visible — `APPROXIMATE` |
| `web.fetch` | PUBLIC | R0 | UNTRUSTED | NONE | – | Isolated pod, no credentials |
| `http.request` | PUBLIC | R3 | TRUSTED | NONE | ✅ | Allowlist only; conservative default |

> **`gmail.send` has `maxTaint: TRUSTED`.** That single field is what stops the lethal trifecta:
> a body derived from an untrusted email may be *shown* to a human, but cannot be sent
> autonomously, and an untrusted value can never populate the recipient. M3 enforces it; M2
> declares it.

### 5.3 Connector SDK

```ts
export abstract class Connector {
  abstract kind: ConnectorKind;
  abstract tools: ToolDeclaration<any, any>[];

  abstract authorize(ctx): Promise<AuthResult>;
  abstract refresh(secretRef): Promise<AuthResult>;
  abstract revoke(secretRef): Promise<void>;
  abstract health(): Promise<HealthReport>;
}
```

The SDK provides, so no connector reimplements them:

| Concern | Behavior |
|---|---|
| Retry | Exponential backoff + jitter; retry only idempotent operations; **never retry an `R2`/`R3` past commit** |
| Rate limiting | Token bucket per tenant per connector, from provider quota metadata; `429` respects `Retry-After` |
| Idempotency | `KEYED` tools get a deterministic key from `run_id + node_id`; `tool_invocations` dedupes |
| Error normalization | Provider errors → `AUTH_EXPIRED`, `RATE_LIMITED`, `NOT_FOUND`, `PERMISSION_DENIED`, `CONFLICT`, `PROVIDER_ERROR`, `TRANSIENT` |
| Token refresh | Transparent, single-flight per connector; failure marks `degraded`, not `revoked` |
| Tracing | Every call spans with `tool_id`, `connector_id`, `run_id` |

### 5.4 `simulate()` — the contract M6 depends on

Every tool must return the effect it *would* produce, in the same shape `execute()` returns.

Three implementation strategies, in preference order:

1. **Provider dry-run**, where offered.
2. **Derived** — compute the effect from resolved arguments plus a read-only lookup
   (e.g. `gcal.create` resolves attendee identities and checks conflicts without writing).
3. **Declared** — for tools where neither is possible, return a conservative effect from the
   declaration and mark `fidelity: 'DECLARED'`.

```ts
interface Effect<T> {
  summary: string;                 // human sentence for the blast radius panel
  fidelity: 'PROVIDER' | 'DERIVED' | 'DECLARED';
  externalRecipients: string[];    // drives risk + duplicate-contact checks (M10)
  recordsAffected: { system: string; id: string; field?: string;
                     before?: unknown; after?: unknown }[];
  monetaryValue?: { currency: string; amount: number };
  reversibilityNote?: string;      // "attendees will see a cancellation"
  detail: T;
}
```

**Divergence rule (enforced in M6):** if the actual effect differs from the simulated effect
beyond a per-tool tolerance, the run aborts and a verification failure is logged. Tools with
`fidelity: 'DECLARED'` cannot be promoted past `SUPERVISED` autonomy in M10.

### 5.5 OAuth broker

- Authorization Code + PKCE; state bound to tenant and user; ≤10 min TTL.
- **Scope minimization:** the requested scope set is computed as the union of scopes from the
  tools actually enabled for that connector — never the provider's convenient superset.
- Tokens envelope-encrypted into `secret_refs`; plaintext never touches Postgres or logs.
- Refresh single-flight per connector; expiry → `degraded` + owner notification.
- Revocation calls the provider's revoke endpoint *and* deletes the secret. Both, in that order.
- Incremental authorization: enabling a tool requiring a new scope triggers a re-consent flow
  rather than pre-requesting everything up front.

### 5.6 MCP compatibility

- **MCP client:** attach third-party MCP servers as connectors. Their tools must be given a
  declaration before use — either published by the server in our extension format, or authored by
  an admin during registration. Undeclared MCP tools are registered `EXTERNAL / R3 / TRUSTED /
  NONE` (maximally conservative) and cannot exceed `SUPERVISED` autonomy.
- **MCP server:** expose VEGA's own governed tools to external clients later (Phase 3+). Interface
  defined now, not implemented.

---

## 6. Frontend

### 6.1 Connector gallery (`/admin/connectors`)

Cards per connector kind: status badge (`active` / `degraded` / `expired` / `revoked`), owning
account, workspace scope, last successful call, and an enabled-tools count.

### 6.2 Consent transparency screen

Shown **before** redirecting to the provider — the screen that earns trust in a security-conscious
sale:

```
Connect Gmail

VEGA will be able to:
  ✓ Read messages and search your mailbox          (gmail.readonly)
  ✓ Create drafts                                   (gmail.compose)
  ✓ Send messages on your behalf                    (gmail.send)
      ⚠ Sending always requires your approval until you
        change this in policy. Every send has a 10-minute
        window in which you can pull it back.

VEGA will NOT:
  ✗ Delete messages
  ✗ Change your account settings
  ✗ Act on instructions contained inside emails it reads

These permissions come from the 6 tools you enabled. [Review tools]
```

Generated from the declarations — never hand-written prose that can drift from what was granted.

### 6.3 Tool inspector (`/admin/connectors/:id/tools`)

Per tool: declared reversibility with a plain-language explanation, egress class, max taint,
whether hold is supported, simulation fidelity, required scopes, and whether a compensator is
registered (from M6). Compliance officers read this screen during procurement — write it for them.

### 6.4 Connector health (`/admin/connectors/:id/health`)

Success rate, p50/p99 latency, rate-limit events, auth refresh history, recent errors with
normalized codes. Recovery actions: re-authorize, revoke, test call.

### 6.5 Component inventory

| Component | Used by |
|---|---|
| `ConnectorCard` | Gallery |
| `ConsentScreen` | Authorize flow |
| `ScopeList` | Consent, inspector |
| `ToolDeclarationTable` | Inspector, and the audit explorer in M7 |
| `ReversibilityBadge` | Reused everywhere from M6 onward |
| `HealthSparkline` | Health, Action Center in M8 |

---

## 7. APIs

```
GET    /v1/connectors                          # list with health
POST   /v1/connectors                          # create pending + return authorize URL
GET    /v1/connectors/:id
PATCH  /v1/connectors/:id                      # display name, workspace scope, enabled tools
DELETE /v1/connectors/:id                      # revoke provider token + delete secret
POST   /v1/connectors/:id/reauthorize
POST   /v1/connectors/:id/test                 # health probe
GET    /v1/connectors/:id/health

GET    /v1/oauth/:kind/authorize               # 302 to provider (PKCE, state)
GET    /v1/oauth/:kind/callback                # exchange, store, redirect

GET    /v1/tools                               # declarations, filterable
GET    /v1/tools/:toolId
POST   /v1/tools/:toolId/simulate              # simulate without executing  ← used by M6
POST   /v1/tools/:toolId/execute               # internal only; M4 calls this, never the browser

POST   /v1/mcp/servers                         # attach a third-party MCP server
GET    /v1/mcp/servers/:id/tools               # discovered tools awaiting declaration
```

`execute` is **not** exposed publicly. Direct execution bypasses planning, policy, taint, and
audit. Gateway routing forbids it from the public listener; a route test asserts this.

---

## 8. Key Flows

### 8.1 Authorize a connector

```
Admin picks Gmail, selects tools to enable
  → API computes minimal scope union from declarations
  → Consent transparency screen (§6.2)
  → 302 to Google with PKCE + state
  → callback: verify state, exchange code
  → envelope-encrypt tokens → secret_refs
  → connectors row → active; probe health
  → connector_event: authorized
```

### 8.2 Invoke a tool (as M4 will call it)

```
executor → connector runtime
  → resolve connector, check status
  → derive idempotency key (run_id + node_id)  [KEYED tools]
  → check tool_invocations for a prior success → short-circuit if found
  → acquire rate-limit token
  → refresh auth if needed (single-flight)
  → execute with timeout
  → normalize errors; record invocation; emit span
  → return Result<Effect>
```

### 8.3 Token expiry

```
refresh fails
  → connector.status = degraded  (NOT revoked — the user did not revoke it)
  → connector_event: auth_expired
  → notify owner + workspace admins
  → runs needing this connector fail with AUTH_EXPIRED and are marked resumable
  → re-authorization resumes them (M4 resumption)
```

---

## 9. Technology

| Concern | Choice | License |
|---|---|---|
| Protocol | Model Context Protocol SDK | MIT |
| Google | `googleapis` | Apache-2.0 |
| Microsoft | `@microsoft/microsoft-graph-client` | MIT |
| Slack | `@slack/web-api` | MIT |
| HTTP | undici | MIT |
| Headless browser | Playwright | Apache-2.0 |
| Email parsing | mailparser | MIT |
| Calendar | ical.js | MPL-2.0 |
| Validation | Zod | MIT |
| Rate limiting | Valkey token bucket | BSD-3 |
| Crypto | Node `crypto` + KMS envelope (M1) | — |

---

## 10. Security

### 10.1 Token handling

Plaintext tokens exist only in memory during a call. Never logged, never in error messages, never
in traces. A Semgrep rule fails the build on any log statement whose argument reaches a token type.

### 10.2 Scope minimization

Requesting `https://mail.google.com/` (full mailbox) is forbidden by policy and by review. Use the
narrowest scope per tool. A connector requesting a scope not derivable from an enabled tool's
declaration fails the certification checklist.

### 10.3 Web fetch isolation

The highest-risk connector — it ingests arbitrary attacker-controlled content:

- Dedicated pod, **no service account token, no connector secrets mounted**
- Egress via a proxy with a denylist for private ranges (`169.254.0.0/16`, `10/8`, `127/8`,
  `metadata.google.internal`) — SSRF defense
- JS disabled by default; enabled per-domain only when a workflow demands it
- Response size and time caps; content-type allowlist
- Output labeled `UNTRUSTED` unconditionally, never overridable
- Active content (scripts, iframes, tracking pixels, remote images) stripped before the content
  reaches any model — remote image loading is an exfiltration channel

### 10.4 Generic HTTP tool

Declared `R3 / PUBLIC` deliberately. Per-tenant destination allowlist, no wildcards. It exists for
internal enterprise APIs, not as a universal escape hatch — and its conservative declaration means
policy treats it as maximally risky until an admin narrows it.

---

## 11. Testing

| Suite | Tool | Gate |
|---|---|---|
| Declaration completeness | Custom + typecheck | **Blocking** — every exported tool has a valid declaration |
| Declaration/DB consistency | Migration test | Blocking — table matches code |
| Connector contract tests | Vitest + sandbox accounts | Blocking per connector |
| Simulation accuracy | Custom (`evals/simulation`) | Nightly; blocks promotion in M10 |
| Idempotency | Integration | Blocking — double invoke produces one effect |
| Rate limit / retry | Toxiproxy | Blocking |
| SSRF / egress | Security suite | **Blocking** |
| Token leak detection | Semgrep + log scan | **Blocking** |
| OAuth flow | Playwright against provider test tenants | Blocking |

### 11.1 Sandbox accounts

Provision dedicated Google Workspace and Microsoft 365 test tenants. Contract tests run against
real APIs, not mocks — mocked connector tests give false confidence about exactly the semantics
(idempotency, partial failure, rate limits) that matter for M6's compensators.

### 11.2 Simulation accuracy harness

For each tool: run `simulate()`, run `execute()`, diff the effects, assert equality within
tolerance, then compensate to restore the sandbox. This harness is reused verbatim by M6 to test
compensators — build it well.

---

## 12. Connector Certification Checklist

No connector reaches production without every box ticked. Recorded in
`tool_declarations.certified_at`.

- [ ] Declaration complete and typechecks for every exported tool
- [ ] Scopes minimized and justified per tool
- [ ] `simulate()` implemented; fidelity honestly declared
- [ ] Simulation accuracy ≥ 99% on the harness
- [ ] Compensator registered and tested for every `R1`/`R2` action *(completed in M6)*
- [ ] Taint classification reviewed by a second engineer
- [ ] Idempotency verified by double-invocation test
- [ ] Rate limits sourced from provider documentation, not guessed
- [ ] Error normalization covers the provider's documented error set
- [ ] Health probe implemented
- [ ] Token refresh and revocation tested end to end
- [ ] No secret appears in any log, trace, or error path

---

## 13. Acceptance Criteria

- [ ] `require-tool-declaration` is enforced; a tool without one fails the build
- [ ] All 8 launch connectors authorize, execute, refresh, and revoke against real sandbox tenants
- [ ] Every launch tool implements `simulate()`; fidelity declared honestly
- [ ] Consent screen is generated from declarations and matches granted scopes exactly
- [ ] Double-invocation with the same idempotency key produces exactly one effect
- [ ] Web-fetch pod cannot reach cloud metadata or private ranges (test proves it)
- [ ] No token material appears in logs, traces, or error responses
- [ ] An MCP server can be attached and its tools registered with declarations
- [ ] Connector health dashboard reflects real provider state
- [ ] Simulation accuracy harness runs nightly and reports per tool

---

## 14. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Provider APIs lack dry-run → weak simulation | D1's blast radius is less trustworthy | Derived simulation; declare fidelity honestly; cap autonomy for `DECLARED` tools |
| Google/Microsoft OAuth app verification takes weeks | Blocks the design partner pilot | **Start verification in week 1 of this module** — it is calendar time, not engineering time |
| Scope minimization fights provider granularity | Over-broad grants weaken the pitch | Document each unavoidable case; surface it honestly on the consent screen |
| Per-connector effort underestimated | Phase 1 slips | Timebox connector #1; measure it; it predicts the M6 compensator cost (PROJECT.md §24) |
| MCP tools arrive undeclared | Governance hole | Conservative defaults + autonomy cap |

> **Measure connector #1 precisely.** PROJECT.md §24 names per-connector economics as the kill
> criterion for the whole thesis. This module produces the first real data point.

---

## 15. Deliverables

- [ ] `packages/contracts/tools.ts` — frozen `ToolDeclaration` API
- [ ] `packages/connectors/*` — one package per connector, all MCP-compatible
- [ ] Connector SDK with retry, rate limiting, idempotency, refresh, normalization
- [ ] OAuth broker + consent transparency screen
- [ ] Token vault integration with envelope encryption
- [ ] Migrations for §4 tables + declaration-sync migration generator
- [ ] Web-fetch isolated pod with egress policy and SSRF tests
- [ ] Connector gallery, consent screen, tool inspector, health dashboard
- [ ] Simulation accuracy harness in `evals/simulation`
- [ ] Certification checklist as a PR template for new connectors
- [ ] Google + Microsoft OAuth app verification submitted

---

## 16. Notes for the Next Module

Module 3 consumes `egress_class` and `max_taint` as its gate condition and labels every connector
output at the source. Ensure `gmail.read`, `gdrive.read`, and `web.fetch` return content already
wrapped in a provenance envelope (`{ value, sourceId, taint }`) rather than bare strings — M3
should be propagating labels, not inventing them.
