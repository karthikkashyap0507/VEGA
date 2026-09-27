# Module 5 — Implementation Record

> What was built for [module5.md](module5.md), where it lives, and how each acceptance criterion
> is proven. The placement decision (the policy decision is made in the execution plane) is D-14
> in [PROJECT.md §25](PROJECT.md).

## Layout

| Path | What |
|---|---|
| `packages/risk` | The risk function: seven factors, bounded versioned weights, the four hard gates, an explanation line per factor. Pure; no I/O |
| `packages/policy-engine/src/schema.ts` | The YAML policy language: strict schema, field vocabulary, predicates (`eq/not/in/not_in/gt/gte/lt/lte/contains/exists`), `all/any/not`; raw Rego refused |
| `…/evaluate.ts` | The reference evaluator (what simulation uses; proved equal to the compiled Rego) |
| `…/compile.ts` | YAML AST → Rego, deterministic (golden files); `exists` compiled through `object.get` so absent ≡ null on both sides |
| `…/combine.ts` | Most restrictive wins; hard gates; tier defaults; the human reason chain; `decidedBy`; `failClosed` |
| `…/presets.ts` | Cautious / Balanced / Fast (§5.7) and the professional-services pack with citations |
| `…/bundle.ts`, `…/distribution.ts` | Signed OPA bundles (ES256, `.signatures.json`), the presets / tenant / discovery bundles, naming and revisions |
| `…/opa.ts` | The OPA client: every failure an exception; `query` returns OPA's provenance (the bundle revision that actually answered) |
| `…/classify.ts` | Presidio client with the vertical recognizers sent ad hoc, secret patterns, markings, sensitivity 0–100 + labels |
| `…/router.ts` | C4 — the model router (D-12): untrusted → quarantined model only, HIGH/CRITICAL → best, residency, below-Teams economy, budget → queue |
| `packages/objectstore` | S3 (SeaweedFS locally, cloud S3 deployed) — bundles now; M6/M7 blobs and evidence next |
| `packages/db/migrations/0008_policy.sql` | policies, policy_bundles, policy_evaluations, risk_evaluations, risk_weights, classifications, policy_simulations; `sched_policy_bundles()` |
| `services/execution/src/policy/` | **The policy hook**: classify → score → OPA → combine → record; fails closed; `/internal/classify` |
| `services/execution/src/executor/` | Hold windows, dual approval, fail-closed stop (changes to `pass.ts`, `workflow.ts`) |
| `services/control/src/policy/` | Bundle signing key + OPA dev config, the publisher (baseline, candidates, activation, discovery), simulation, line diff |
| `services/control/src/routers/{policies,risk}.ts` | The console's API; approver-role / SoD enforcement and hold release/revoke in `runs.ts` |
| `services/control/src/agent/routing.ts` | C4 applied to planning: the tenant's plan, residency and budget choose the planner model |
| `services/gateway/src/routes/policies.ts` | `/v1/policies*`, `/v1/risk/*`, `/v1/evaluations`; `/v1/runs/:id/{release,revoke}` |
| `apps/web` | `/admin/policies` (CodeMirror YAML editor with autocomplete and live validation, versions and diff, bundles), `/admin/policies/simulate`, `/admin/risk`; `RiskExplanation` in the action card and the run inspector's Policy tab; the hold card |
| `infra/docker` | SeaweedFS, OPA (signed discovery), Presidio 2.2.362; `pnpm policy:setup` |
| `infra/helm/platform/templates/policy.yaml` | OPA and Presidio in the execution namespace; network policies (execution → OPA/Presidio only; OPA → object storage only; Presidio → nothing) |

## How a step is decided

```
executor, inside the durable step for the call (so a replay gets the recorded decision):
  policyHook(StepContext)
    → generated content (string args minus recipients) → digest → classifications cache | Presidio
    → RiskInput (sensitivity, blast radius, exposure, irreversibility, authority, taint, scope)
    → scoreRisk(input, the tenant's weights version)
    → OPA: data.vega.presets.<mode>.matches  ∥  data.vega.t_<tenant>.matches (required once activated)
    → combine: gates · every match · tier default (always at HIGH/CRITICAL) → most restrictive
    → record risk_evaluations + policy_evaluations (+ policy.denied_action / risk.critical events)
  ALLOW → run · ALLOW_WITH_HOLD → HELD, durable window, releases itself (release early / revoke)
  REQUIRE_APPROVAL → one approver holding approver_role · REQUIRE_DUAL_APPROVAL → two distinct, SoD
  DENY → replan around it · fail-closed DENY → the run FAILS (replanning into an outage is pointless)
```

Distribution: author (YAML) → draft → **build** (compile + sign → `tenants/<t>/v<n>.tar.gz`) →
**simulate** (required) → **activate** (the candidate's signed bytes → `tenants/<t>/bundle.tar.gz`,
discovery rebuilt) → OPA polls, verifies the signature, loads it. Neither plane calls the other.

## Decisions worth knowing

- **The decision is made in the execution plane (D-14).** §3 draws a "Policy Service (control
  plane)", but invariant 1 forbids execution calling control. The engine is a library in the
  execution plane with OPA and Presidio as execution-side services; authoring, compilation,
  simulation, signing and activation stay in control. The two meet only in object storage (signed
  bundles) and the database.
- **Fail closed, everywhere.** OPA unreachable, a bundle that should be loaded and is not, Presidio
  down, the database refusing the record — each is a DENY with `fail_closed = true`, an alert
  (`policy.unavailable` event + ntfy page) and a FAILED run. A missing tenant package is an outage
  only when the database says a bundle was activated; OPA readiness is *not* `?bundles=true`
  (one tenant's broken bundle must not take every tenant down).
- **Evaluations record what actually decided.** The bundle revision comes from OPA's provenance
  on the query, not from the database — for the seconds after an activation they can differ.
- **Simulation recomputes both sides** from stored inputs (the OPA input document and the risk input
  with its recorded weights version) with the reference evaluator, so a reported change is caused
  by the policy edit alone. One action counts once (latest evaluation per journal row).
- **Three facts the spec leaves open** (engine header): the declaration's `sensitivityHint` is the
  prior; classified content replaces it but never drops below half of it. Messaging tools affect
  their recipients, not records. For the risk factor only, a send to the organization's own domains
  is internal exposure; the policy input keeps the declared egress class.
- **A matched policy's hold still applies after approval** (combine's `holdWindowMs`): approved and
  still revocable for the window, as in the §5.5 example (approval + 15-minute hold).
- **Weights versions are global** (a sequence): a stored `weights_version` names one weight set
  whichever tenant owns it. Evaluations and weights are append-only at the privilege level
  (`REVOKE UPDATE, DELETE`), asserted by the isolation suite.
- **Approver roles.** `canApproveAs`: APPROVER → any role that decides approvals; ADMIN →
  ADMIN/OWNER; OWNER → OWNER; a role the tenant does not have (REGISTERED_PRINCIPAL) → ADMIN/OWNER
  until M8 routes to named groups. The control plane refuses with a reason; the executor enforces
  distinctness and SoD again, because the approval is what lets the action happen.
- **Authoring is `policy.manage` (ADMIN, OWNER)** per the M1 matrix and §10, on plans that expose
  `policyAuthoring` (Teams, Enterprise). The preset mode is open to every plan (D-09). Compliance
  officers read and review; they author through an ADMIN until M1's matrix changes.
- **C4 plan names** follow `plan_entitlements` (free, pro, business, teams, enterprise): economy
  planning below Teams.

## Acceptance criteria (§12)

| Criterion | Status | Proof |
|---|---|---|
| YAML compiles to Rego deterministically; golden files | ✅ | `packages/policy-engine/test/engine.test.ts` (goldens, `opa check --strict`); Rego unit tests `test/rego/*_test.rego` run by `opa test` (15/15) |
| Every action evaluated produces a persisted decision and a reason chain | ✅ | `services/execution/test/policy.test.ts` (every step recorded, chain stored); E2E inspector Policy tab |
| Risk scores reproducible from stored factors and weights version | ✅ | `policy.test.ts` replays every stored evaluation with its recorded weights → identical score, tier, factors, gates |
| All four hard gates fire and cannot be overridden by a low score | ✅ | `packages/risk/test/risk.test.ts` (positive and negative per gate); combination property; RESTRICTED → dual approval end to end |
| Most-restrictive-wins holds under property testing | ✅ | 2 000-run property in `engine.test.ts` |
| Presidio ≥ 95% recall on the vertical corpus | ✅ **99.0%** (102/103) | `packages/policy-engine/test/classify.test.ts` against Presidio 2.2.362; the one miss is an NER miss on a name |
| Simulation over 90 days reports changes accurately | ✅ | `services/control/test/policies.test.ts` — exact counts with out-of-window and re-evaluated actions; E2E |
| A bundle cannot be activated without a simulation | ✅ | control test (422) and the console (Activate disabled) in E2E |
| OPA unavailable → all actions denied, alert fires, nothing proceeds | ✅ | chaos: an OPA container killed mid-run (`policy.test.ts`); unloaded bundle; a throwing hook |
| Decision latency p99 < 50 ms | ✅ **p99 ≈ 13–17 ms** locally | `policy.test.ts`, 300 decisions on a warm engine including the database record (classification cached, as in steady state) |
| Risk explanation panel in chat, ready for M8's packet | ✅ | `RiskExplanation` in the action card and hold card; E2E asserts factors and the deciding policy |
| The four tiers behave per §7.3 defaults | ✅ | `TIER_DEFAULT` + combination tests |

The differential suite (compiled Rego ≡ reference evaluator on a live OPA, absent and null fields
included) is BLOCKING in CI (`policy-engine` job), as is signed-bundle verification and tamper
refusal both in `opa build` and in a running OPA fed through discovery.

## External items

- **Weights are guesses** (§13). The v1 weights make a plain external send MEDIUM (held), a send
  with personal data or to several people HIGH (approval). Calibrate in shadow mode with the design
  partner; tenants can tune within bounds with the live preview.
- **SeaweedFS identities.** SeaweedFS 3.97 did not honour a second, bucket-scoped read-only identity
  for objects written by the first, so the local stack uses one identity. Deployed S3 gives OPA a
  read-only IAM role scoped to the policy bucket (`policy.opa.storeSecret`).
- **OPA decision logs** are off; `policy_evaluations` is the record (inputs, matches, chain). M7
  chains them into the evidence plane.
