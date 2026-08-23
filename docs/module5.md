# Module 5 — Policy, Risk & Data Classification

> C3 plus the risk scoring function. The layer that decides, for every action: allowed at all? at
> what autonomy? by whom? Transparent and auditable by construction — a compliance officer must be
> able to read why any decision was made.

| | |
|---|---|
| **Phase** | 1 (months 5–6) |
| **Covers** | C3 (§7.3), **C4 model router (§7.4, assigned by D-12)**, §13 risk scoring, §16 DLP, §22.6 tier margin |
| **Depends on** | M1 (roles), M2 (declarations), M3 (taint), M4 (`policyHook`) |
| **Blocks** | M6 (risk drives hold windows), M8 (approval routing), M10 (autonomy interacts with policy) |
| **Estimate** | 6–7 engineer-weeks |

---

## 1. Purpose & Scope

### 1.1 What this module delivers

Every action passes through a policy decision that returns one of `ALLOW`, `ALLOW_WITH_HOLD`,
`REQUIRE_APPROVAL(role)`, `REQUIRE_DUAL_APPROVAL`, or `DENY` — together with the **reason chain**
that produced it. Plus a risk score computed from six explainable factors, and PII/PHI detection
feeding data sensitivity.

### 1.2 The design constraint that shapes everything

> The risk function is **not a model**. It is a transparent, versioned, unit-testable function.

Reasons: a compliance officer must be able to read it; the score must be reproducible on replay
(M7); and an opaque score cannot support an EU AI Act Art. 12 audit. When someone proposes
"just let an LLM score the risk," the answer is no — an LLM *may* supply an input (a sensitivity
hint), but never the score.

### 1.3 In scope

- Policy DSL (YAML) → Rego compilation; versioned, signed OPA bundles
- OPA integration with decision logs feeding `policy_evaluations`
- Risk scoring function with versioned weights and hard gates
- PII/PHI/secret detection via Presidio; sensitivity labeling
- Policy simulation — replay historical actions against a candidate bundle
- Vertical policy packs (beachhead) with regulatory citations
- Budget policy: cost caps as a policy input
- **C4 model router**: routing rules, hard overrides, tier-aware model selection
- **Policy preset modes** (Cautious / Balanced / Fast) for self-serve tiers
- Frontend: policy console, policy simulator, risk explanation panel

### 1.4 Out of scope

Approval UX and routing execution (M8 — this module decides *that* approval is needed and by
which role) · autonomy tiers (M10 — a separate axis that can only downgrade a policy disposition)
· audit persistence (M7).

---

## 2. Dependencies

| From | Needs |
|---|---|
| M1 | Role model, tenant settings |
| M2 | `egressClass`, `reversibility`, `sensitivityHint`, `scopes` from declarations |
| M3 | Taint level of resolved arguments (`taintPressure`) |
| M4 | `policyHook` with full node context (over-provided per M4 §15) |

---

## 3. Architecture

```
        M4 executor
            │  PolicyRequest (full node context)
            ▼
┌──────────────────────────────────────────────────────────┐
│  Policy Service (control plane)                          │
│                                                          │
│  1. Classify      → Presidio: PII/PHI/secrets → 0-100    │
│  2. Score         → packages/risk (versioned function)   │
│  3. Evaluate      → OPA (compiled bundle, per tenant)    │
│  4. Combine       → hard gates override score            │
│  5. Record        → policy_evaluations + decision log    │
└──────────────────────────────────────────────────────────┘
            │  PolicyDecision + reason chain
            ▼
        M4 executor  →  M6 (hold) / M8 (approval) / abort
```

Policy evaluation is **synchronous and fast** — it sits in the execution path of every step.
Budget: p99 < 50ms. Presidio runs on generated content only, not on every argument.

---

## 4. Data Model

```sql
-- ============ Policies (authored YAML, compiled to Rego) ============
CREATE TABLE policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id),
  key          text NOT NULL,            -- 'external-comms-supervision'
  version      int  NOT NULL,
  spec_yaml    text NOT NULL,            -- source of truth, human-authored
  compiled_rego text NOT NULL,           -- generated, never hand-edited
  citation     text,                     -- 'FINRA 2210', 'EU AI Act Art.14'
  description  text NOT NULL,
  severity     text NOT NULL DEFAULT 'normal',
  author_id    uuid NOT NULL REFERENCES users(id),
  active_from  timestamptz,
  active_to    timestamptz,
  state        text NOT NULL DEFAULT 'draft',   -- draft|simulated|active|retired
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key, version)
);

-- ============ Signed bundles shipped to OPA ============
CREATE TABLE policy_bundles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  version     int  NOT NULL,
  policy_ids  uuid[] NOT NULL,
  bundle_ref  text NOT NULL,          -- object storage key
  digest      text NOT NULL,
  signature   text NOT NULL,
  activated_at timestamptz,
  activated_by uuid REFERENCES users(id),
  UNIQUE (tenant_id, version)
);

-- ============ Every evaluation, recorded ============
CREATE TABLE policy_evaluations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  run_id         uuid NOT NULL,
  action_id      uuid,
  node_id        uuid NOT NULL,
  bundle_version int  NOT NULL,
  policy_key     text NOT NULL,
  policy_version int  NOT NULL,
  decision       text NOT NULL,       -- ALLOW|ALLOW_WITH_HOLD|REQUIRE_APPROVAL|
                                      -- REQUIRE_DUAL_APPROVAL|DENY
  approver_role  text,
  hold_window_ms int,
  reason_json    jsonb NOT NULL,      -- the reason chain
  evaluated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON policy_evaluations (run_id, node_id);

-- ============ Risk scores (reproducible) ============
CREATE TABLE risk_evaluations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  action_id      uuid,
  node_id        uuid NOT NULL,
  score          int  NOT NULL,
  tier           text NOT NULL,       -- LOW|MEDIUM|HIGH|CRITICAL
  weights_version int NOT NULL,
  factors_json   jsonb NOT NULL,      -- every input, for replay + explanation
  hard_gate      text,                -- which gate fired, if any
  evaluated_at   timestamptz NOT NULL DEFAULT now()
);

-- ============ Risk weights (data, versioned) ============
CREATE TABLE risk_weights (
  version     int PRIMARY KEY,
  tenant_id   uuid,                   -- null = global default
  weights     jsonb NOT NULL,         -- { w1..w7 }
  boundaries  jsonb NOT NULL,         -- { low:25, medium:55, high:80 }
  active_from timestamptz NOT NULL,
  author_id   uuid
);

-- ============ Sensitivity classification cache ============
CREATE TABLE classifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL,
  content_digest text NOT NULL,
  entities    jsonb NOT NULL,         -- [{type:'EMAIL', score:0.9, start, end}]
  sensitivity int  NOT NULL,          -- 0-100
  labels      text[] NOT NULL,        -- PII|PHI|PCI|SECRET|CONFIDENTIAL
  classified_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, content_digest)
);

-- ============ Simulation results ============
CREATE TABLE policy_simulations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  bundle_id     uuid NOT NULL REFERENCES policy_bundles(id),
  window_from   timestamptz NOT NULL,
  window_to     timestamptz NOT NULL,
  actions_replayed int NOT NULL,
  changes_json  jsonb NOT NULL,       -- what would have changed
  run_by        uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

---

## 5. Backend

### 5.1 Policy DSL

Compliance officers author YAML. Nobody writes Rego by hand.

```yaml
- id: external-comms-supervision
  description: Client-facing communications require principal review
  citation: FINRA 2210
  severity: high
  when:
    all:
      - tool.egress_class: EXTERNAL
      - target.audience: CLIENT
  then:
    decision: REQUIRE_APPROVAL
    approver_role: REGISTERED_PRINCIPAL
    hold_window: 15m
    evidence: [draft_body, source_provenance, client_record]

- id: untrusted-recipient-block
  description: A recipient derived from untrusted content is never permitted
  citation: internal-sec-001
  severity: critical
  when:
    all:
      - tool.egress_class: EXTERNAL
      - args.recipient.taint: { not: TRUSTED }
  then:
    decision: DENY
    reason: "Recipient must be a resolved, trusted entity"

- id: large-value-dual-approval
  when:
    all:
      - effect.monetary_value.amount: { gte: 10000 }
  then:
    decision: REQUIRE_DUAL_APPROVAL
    approver_role: ADMIN
    separation_of_duties: true
```

**Compilation:** YAML → validated AST → Rego. The compiler is deterministic and its output is
committed alongside the source so a reviewer sees both.

**Why compile to Rego rather than evaluate the YAML directly:** OPA's decision logs give a native,
structured record of every evaluation with inputs and result — exactly what `policy_evaluations`
needs and what an Art. 12 audit expects. Building our own evaluation-recording layer would
duplicate it badly.

### 5.2 Risk scoring — `packages/risk`

```ts
export function scoreRisk(input: RiskInput, weights: Weights): RiskResult {
  const factors = {
    dataSensitivity:   input.sensitivity,                  // 0-100 (Presidio + labels)
    blastRadius:       blastRadiusScore(input.effect),     // recipients, records, value
    externalExposure:  { INTERNAL: 0, EXTERNAL: 60, PUBLIC: 100 }[input.egressClass],
    irreversibility:   { R0: 0, R1: 25, R2: 60, R3: 100 }[input.reversibility],
    authorityGap:      authorityGap(input.principal, input.tool),
    taintPressure:     { TRUSTED: 0, ORG: 40, UNTRUSTED: 100 }[input.argTaint],
    certificationCredit: input.certification?.agreementRate ?? 0,   // M10 supplies this
  };

  const raw =
      weights.w1 * factors.dataSensitivity
    + weights.w2 * factors.blastRadius
    + weights.w3 * factors.externalExposure
    + weights.w4 * factors.irreversibility
    + weights.w5 * factors.authorityGap
    + weights.w6 * factors.taintPressure
    - weights.w7 * factors.certificationCredit;

  const score = clamp(0, 100, raw);
  return { score, tier: tierOf(score, weights.boundaries), factors,
           weightsVersion: weights.version };
}
```

**Hard gates — bypass the score entirely, never overridable by a good score:**

| Condition | Result |
|---|---|
| `R3` + `EXTERNAL` | at least `HIGH` |
| Any `UNTRUSTED` value determining a recipient | `CRITICAL` (and `DENY` per policy) |
| Action outside the principal's granted scope | `DENY`, unconditionally |
| Resource labeled `RESTRICTED` | dual approval minimum |

Default boundaries: `LOW < 25 ≤ MEDIUM < 55 ≤ HIGH < 80 ≤ CRITICAL`.

**Reproducibility:** every evaluation stores `weights_version` and the full `factors_json`.
Replay (M7) recomputes with the recorded weights, not the current ones. A test asserts that
replaying a stored evaluation yields an identical score.

### 5.3 Data classification (Presidio)

- Runs on **generated content and retrieved documents**, not on every argument — it is the most
  expensive step in the path.
- Results cached by content digest (`classifications`), so repeated evaluation is free.
- Custom recognizers for the beachhead vertical: account numbers, client identifiers, policy
  numbers, medical record numbers.
- Secret detection (detect-secrets/Gitleaks patterns) for credentials accidentally included in a
  draft.
- Output: entity list with confidence, plus a 0–100 sensitivity used as risk factor 1.

**Presidio produces confidence scores, not booleans** — which is precisely why it maps cleanly onto
a graded risk input rather than a binary flag.

### 5.4 Decision combination

```
1. classify content → sensitivity
2. score risk → (score, tier, factors)
3. evaluate OPA bundle → set of matched policy decisions
4. combine:
     - any DENY               → DENY (most restrictive wins, always)
     - any hard gate          → apply it, overriding the score-derived tier
     - most restrictive of the remaining policy decisions
     - default disposition by tier if no policy matched:
         LOW → ALLOW · MEDIUM → ALLOW_WITH_HOLD
         HIGH → REQUIRE_APPROVAL · CRITICAL → DENY
5. M10 autonomy tier may only DOWNGRADE the disposition, never upgrade it
6. record evaluation + reason chain
```

**Most restrictive wins** is the invariant. There is no policy precedence order in which a
permissive policy can override a restrictive one — that eliminates an entire class of
misconfiguration.

### 5.5 Reason chain

Every decision carries a human-readable chain:

```jsonc
{
  "decision": "REQUIRE_APPROVAL",
  "chain": [
    { "step": "risk", "detail": "score 68 (HIGH): external exposure 60, irreversibility 60 (R2), taint pressure 100" },
    { "step": "policy", "id": "external-comms-supervision", "version": 7,
      "citation": "FINRA 2210", "detail": "EXTERNAL egress + CLIENT audience" },
    { "step": "combine", "detail": "policy REQUIRE_APPROVAL is more restrictive than tier default" },
    { "step": "autonomy", "detail": "workflow tier SUPERVISED — no downgrade applied" }
  ],
  "approver_role": "REGISTERED_PRINCIPAL",
  "hold_window_ms": 900000
}
```

This chain is rendered verbatim in the approval packet (M8) and the audit trace (M7). Write it
for a human from the start — it is a user-facing artifact, not a debug log.

### 5.6 C4 — Intelligent Model Router

> **Assigned here by PROJECT.md decision D-12.** Routing rules *are* policy — risk-tier accuracy
> floors, taint-based restrictions, and residency pinning are all policy decisions about which
> model may see which data. They belong with the policy engine, not scattered in the executor.

**Never a marketed feature** at Enterprise — but **existential below Teams** (PROJECT.md §22.6).
At enterprise ACV inference cost is a rounding error; at $30/month it is the entire business.

**Routing signals:** task complexity, reasoning requirement, context size, latency budget, cost
budget, data residency/privacy constraints, and the accuracy floor for the action's risk tier.

**Hard rules that override cost optimization — enforced here, not in the gateway:**

| Rule | Reason |
|---|---|
| High/Critical tier → highest-accuracy model, regardless of cost | Error rate at these tiers gates autonomy (M10) |
| Any prompt containing `UNTRUSTED` taint → quarantined model only | M3 §7.5 — never the privileged planner |
| Residency-constrained tenants → approved regions/providers only | Tenant `region` setting (M1) |
| Self-serve tiers → Sonnet/Haiku-class planning + self-hosted extraction | Margin (§22.6) |

**Implementation:** thin policy layer over LiteLLM (TECHSTACK §10.1). LiteLLM handles providers,
virtual keys, spend tracking, and caching; we own only the rules above. **Do not build a gateway.**

**Tier interaction — the margin inversion.** The low tiers force cheaper planning, and cheaper
planning means a higher error rate, which is exactly what the thesis bounds. Consequences:

- Hard budget caps ship with the first self-serve account. Breach **degrades or queues; it never
  bills a surprise and never silently upgrades the model.**
- Model choice is recorded per action in the M7 receipt, so a tier's error rate is attributable to
  its routing policy rather than guessed at.
- Per-tier contribution margin is an internal metric from the first paying SMB account. **A tier
  that cannot reach positive margin at target usage does not ship.**

### 5.7 Policy preset modes (self-serve tiers)

SMB and individual users never author YAML. They pick one of three preset modes, which compile to
the same bundles the enterprise path produces — same engine, different exposure (D-09):

| Mode | Behavior |
|---|---|
| **Cautious** | Every `EXTERNAL` action requires approval; long hold windows; low autonomy ceiling |
| **Balanced** (default) | External sends held with a revoke window; internal `R0`/`R1` automatic |
| **Fast** | Internal actions automatic; external held briefly; approval only at HIGH+ tier |

Hard gates (§5.2) apply identically in every mode. A preset can relax *defaults*; it can never
disable a hard gate, and no preset permits an `UNTRUSTED`-derived recipient.

### 5.8 Policy simulation

Replays historical actions from a window against a candidate bundle and reports what would change:

```
Candidate bundle v12 vs. active v11 — 2,431 actions over 90 days

  Newly requiring approval:      +47   (mostly gmail.send to first-contact domains)
  Newly auto-approved:            −12   (gcal.update within the same workspace)
  Newly denied:                    +3   ⚠ review these
  Unchanged:                    2,369

  Estimated additional approvals/week: ~4
```

**Simulation is a required gate before activation** — a bundle cannot move to `active` without a
simulation result attached. This is what stops a well-meaning policy edit from either flooding
the approval queue or silently opening a hole.

---

## 6. Frontend

### 6.1 Policy console (`/admin/policies`)

- List with state, version, citation, severity, and last-modified.
- YAML editor with schema validation, autocomplete over tool ids and fields, and inline errors.
- Side-by-side diff between versions.
- Activation flow: draft → **simulate (required)** → review changes → activate.
- Retire with an effective date; never hard-delete (audit history depends on the row).

### 6.2 Policy simulator (`/admin/policies/simulate`)

Window selection, candidate bundle selection, and a results view grouped by change type. Each
changed action links to its run and shows the old and new reason chains side by side.

### 6.3 Risk explanation panel

Rendered on any action card (M4), approval packet (M8), or audit entry (M7):

```
Risk: HIGH (68)

  External exposure     60  ██████░░░░  sends outside the organization
  Irreversibility       60  ██████░░░░  R2 — cannot be recalled after release
  Taint pressure       100  ██████████  content derived from an external email
  Data sensitivity      35  ███░░░░░░░  1 client identifier detected
  Blast radius          20  ██░░░░░░░░  2 recipients
  Authority gap          0  ░░░░░░░░░░  within your granted scope

  Policy: external-comms-supervision (FINRA 2210) → approval by a
  Registered Principal, 15-minute hold window.
```

Bars plus numbers plus text — never color alone (these screens end up in compliance evidence, and
often printed).

### 6.4 Risk weights admin (`/admin/risk`)

Tenant-tunable weights within bounds, with a live preview against recent actions showing the tier
distribution shift. Changing weights creates a new version; it never mutates history.

---

## 7. APIs

```
GET    /v1/policies                       # list, filter by state
POST   /v1/policies                       # create draft
PUT    /v1/policies/:key                  # new version
POST   /v1/policies/:key/retire
GET    /v1/policies/:key/versions
GET    /v1/policies/:key/diff?from=&to=

POST   /v1/policies/simulate              # { bundle, window } → change report
GET    /v1/policies/simulations/:id
POST   /v1/policies/bundles/:id/activate  # requires an attached simulation

GET    /v1/risk/weights
PUT    /v1/risk/weights                   # creates a new version
POST   /v1/risk/score                     # dry-run scoring for a hypothetical action

GET    /v1/evaluations?run_id=            # policy + risk evaluations for a run
POST   /v1/classify                       # classify content → sensitivity (internal)

Webhooks: policy.activated · policy.denied_action · risk.critical
```

---

## 8. Key Flows

### 8.1 Evaluating a step

```
executor → policyHook(node context)
  → classify generated content (cached by digest)
  → scoreRisk(factors, active weights)
  → OPA evaluate(bundle, input)
  → combine (most restrictive wins; hard gates override)
  → persist policy_evaluations + risk_evaluations
  → return decision + reason chain
  → executor routes: ALLOW → execute · HOLD → M6 · APPROVAL → M8 · DENY → abort
```

### 8.2 Activating a policy

```
Author edits YAML → validate → compile to Rego → save draft
  → run simulation over 90 days (REQUIRED)
  → review change report; +3 newly denied actions inspected
  → activate → build bundle → sign → push to OPA → bundle version recorded
  → audit entry (M7) for the activation itself
```

---

## 9. Technology

| Concern | Choice | License |
|---|---|---|
| Policy evaluation | Open Policy Agent (Rego) | Apache-2.0 |
| Policy distribution | OPA bundles, signed | Apache-2.0 |
| Policy authoring | Our YAML DSL + compiler | ours |
| Risk function | `packages/risk`, plain TypeScript | ours |
| PII/PHI detection | Microsoft Presidio (+ spaCy) | MIT |
| Secret detection | detect-secrets patterns | Apache-2.0 |
| Editor | CodeMirror 6 with YAML mode | MIT |
| Testing | OPA test framework + Vitest | Apache-2.0 / MIT |

**Presidio deployment:** runs as a sidecar service (Python) called over HTTP from the policy
service. Keep it out of the Node process — it is the one place Python earns its place in the
serving path.

---

## 10. Security

| Control | Implementation |
|---|---|
| Policy tampering | Bundles signed; OPA verifies signature before loading |
| Policy bypass | `policyHook` is not optional — the executor has no code path around it (test-asserted) |
| Fail closed | OPA unreachable or bundle invalid → `DENY` everything, alert. **Never fail open** |
| Privilege escalation via policy | Policy edits require `ADMIN`; activation is audited; separation of duties on dual-approval rules |
| Classification data | Content digests only in `classifications`; never the content itself |
| Weight manipulation | Bounded ranges; versioned; changes audited |

**Fail-closed is worth emphasizing.** A policy service outage stops the product. That is correct:
an ungoverned agent acting on a customer's mailbox is worse than a stopped one. Make the outage
loud and the recovery fast, but never make it permissive.

---

## 11. Testing

| Suite | Tool | Gate |
|---|---|---|
| YAML→Rego compiler | Golden files | Blocking |
| Rego unit tests | OPA test | Blocking |
| Risk function | Vitest + table-driven cases | Blocking |
| **Risk reproducibility** | Replay stored evaluations → identical scores | **Blocking** |
| Hard gate coverage | Every gate condition, positive and negative | **Blocking** |
| Combination logic | Property-based: most restrictive always wins | **Blocking** |
| Presidio recognizers | Labeled corpus per vertical | ≥ 95% recall on PII |
| Policy simulation | Integration against seeded history | Blocking |
| Fail-closed | Chaos: kill OPA mid-run, assert DENY | **Blocking** |
| Decision latency | Load test | p99 < 50ms |

### 11.1 Property test that matters most

> For any set of matched policies and any risk score, the combined decision is at least as
> restrictive as the most restrictive individual input.

Generate random policy sets and scores; assert the ordering `DENY > DUAL > APPROVAL > HOLD >
ALLOW` is never violated. This eliminates the misconfiguration class where a permissive rule
shadows a restrictive one.

---

## 12. Acceptance Criteria

- [ ] YAML policies compile to Rego deterministically; golden files pass
- [ ] Every action evaluated produces a persisted decision **and** a human-readable reason chain
- [ ] Risk scores are reproducible from stored factors and weights version
- [ ] All four hard gates fire correctly and cannot be overridden by a low score
- [ ] Most-restrictive-wins holds under property testing
- [ ] Presidio detects PII/PHI at ≥ 95% recall on the vertical corpus
- [ ] Policy simulation runs over 90 days of history and reports changes accurately
- [ ] A bundle cannot be activated without an attached simulation
- [ ] OPA unavailable → all actions denied, alert fires, no action proceeds
- [ ] Decision latency p99 < 50ms
- [ ] Risk explanation panel renders in chat, and is ready for M8's packet
- [ ] The four risk tiers behave per PROJECT.md §7.3 defaults

---

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Weights are guesses | Miscalibrated tiers; over- or under-approval | Calibrate against design-partner history in shadow mode; M10's override data recalibrates empirically |
| Presidio latency in the hot path | Slow runs | Cache by digest; classify generated content only; async pre-classification where possible |
| Policy authors write Rego directly | Unreviewable policy, lost citations | YAML is the only supported authoring path; raw Rego rejected at the API |
| Compliance officers cannot use the console | Policy ossifies; engineering becomes the bottleneck | Usability-test the console with the design partner's actual compliance officer |
| Over-restrictive defaults | Product feels useless in the pilot | Tune with the design partner in shadow mode before any real autonomy |
| Score becomes a black box over time | Audit failure | Any proposal to use an ML model for the score is rejected by design (§1.2) |

---

## 14. Deliverables

- [ ] `packages/policy-engine` — YAML schema, compiler, OPA client, bundle builder/signer
- [ ] `packages/risk` — scoring function, hard gates, versioned weights
- [ ] `services/control/policy` — evaluation endpoint, combination logic, reason chains
- [ ] Presidio sidecar deployment + custom vertical recognizers
- [ ] Migrations for all §4 tables
- [ ] Policy console, simulator, risk explanation panel, weights admin
- [ ] Beachhead vertical policy pack with regulatory citations
- [ ] Test suites incl. reproducibility, hard gates, property-based combination, fail-closed
- [ ] `policyHook` default in M4 replaced; its warning removed

---

## 15. Notes for the Next Module

Module 6 consumes `hold_window_ms` and `decision` from this module. Ensure `ALLOW_WITH_HOLD`
returns a window derived from policy *and* risk tier (policy wins where both apply), and that the
decision object carries `reversibility` and the simulated `effect` forward — M6 needs all three to
build the blast radius panel without re-deriving them.
