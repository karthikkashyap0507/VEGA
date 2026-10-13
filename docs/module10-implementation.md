# Module 10 — Implementation Record

> What was built for [module10.md](module10.md), where it lives, and how each acceptance
> criterion is proven. The shape decision (a tier is a row the executor reads fresh on every
> consequential call; contention is arbitrated by Postgres, not by a cache; the control plane only
> ever asks for evidence and records a person's decision) is D-19 in [PROJECT.md §25](PROJECT.md).
>
> **Scope, honestly.** 10A (earned autonomy) and 10B (contention control) are built in full. 10C is
> built where it is code: team templates, "an agent change resets certification", usage analytics,
> anomaly alerts and budget caps with all three breach behaviors. The deployment modes, SCIM and
> SOC 2 collection in §13, and the marketplace in §14 (deferred by the spec itself) are not
> software this repository can contain — see [What is not here](#what-is-not-here).

## Layout

| Path | What |
|---|---|
| `packages/db/migrations/0013_autonomy.sql` | `autonomy_state` (one row per tenant × workflow × action), `certifications`, `autonomy_transitions` (**append-only** for `vega_app`), `policy_proposals`, `novelty_baselines`; `entity_locks` (a partial unique index makes a second EXCLUSIVE_WRITE or COMMUNICATION holder impossible, not merely unlikely), `entity_lock_waits`, `contact_ledger` (**append-only**), `write_conflicts`, `budgets`. RLS forced on all ten; every one is in the isolation suite |
| `packages/autonomy` | The ladder and everything that moves it. `ladder.ts` — tiers, `stricter()` (the only way a tier folds into policy: it can add supervision, never remove it), deterministic sampling. `certification.ts` — scoring and the gate. `promotion.ts` — `PromotionEngine.ratify`, the **only** function that raises a tier. `demotion.ts` — `DemotionEngine`, deliberately with no inverse. `novelty.ts` — feature statistics and z-distance (no model). `proposals.ts` — mining. `store.ts` — rows + the platform events a webhook subscribes to |
| `packages/contention` | `locks.ts` (`LockManager`: acquire, heartbeat, release, cycle breaking, admin release), `contacts.ts` (`ContactLedger`: per-identity cooldown, identity normalization, audited override), `reconcile.ts` (`WriteReconciler`: declare → proceed / merge / defer / escalate) |
| `services/execution/src/autonomy/engine.ts` | `AutonomyEngine.fold()` — **the enforcement point**. Reads the pair's state fresh per call; untiered pair = no-op; R0 and DENY pass through; version-pin check (connector or planning model moved → demote on the spot); rolling-window error-rate and volume-spike triggers; the tier's own floor (supervised, or a deterministic 1-in-N sample); novelty routes **that call** to a person without touching the tier; budget `halt` DENYs in-flight steps. Automatic demotions are also appended to the evidence chain (`autonomy.changed`) |
| `services/execution/src/contention/guard.ts` | `ContentionGuard`: before a consequential call — cooldown check, COMMUNICATION lock per external recipient, EXCLUSIVE_WRITE lock per business record (sorted, so two runs cannot acquire in opposite orders), contact ledger entry (atomic per identity), declared writes. Communication locks are released when the call returns; entity locks are held to the end of the run |
| `services/execution/src/executor/{pass,workflow}.ts` | The hooks: `autonomy` slot after `policy` (`HOOK_ORDER` in `packages/orchestration`), the contention guard after simulation, release in `finally`, `endRun` on any terminal state. Demotion triggers wired at their sources: an approver changing a recipient and post-commit verification failure (`critical_error`), a failed undo (`comp_failure`), a taint violation |
| `services/control/src/autonomy/service.ts` | `AutonomyService`: overview (30-day numbers per pair + gate), `certify` (signs the report into the chain **before** the row exists), `ratify`, manual `demote`, `onAgentVersionChange`, proposals, contention operations, usage analytics, anomaly detection, budgets |
| `services/control/src/autonomy/templates.ts` | The five team templates with their policy bindings; each starts at SHADOW |
| `services/control/src/routers/autonomy.ts` | `autonomy.*`, `contention.*`, `usage.*`, `budgets.*`, `teamTemplates.*` — capability- and exposure-gated |
| `services/control/src/routers/agents.ts` | `saveAgentSpec` (extracted; used by `putSpec` and by applying a template): a spec that differs from the previous version demotes pairs above SUPERVISED with trigger `version_change` |
| `services/control/src/agent/routing.ts` | Budget breach behaviors for the planner route: `degrade` → the economy model, `queue`, `halt`; each emits `budget.exceeded` (at most hourly) |
| `services/gateway/src/routes/autonomy.ts` | Every §16 route, plus `enroll`, `proposals/generate`, `usage/anomalies`, `team-templates`, `agents/:id/apply-template` |
| `packages/contracts/src/evidence.ts`, `services/evidence/src/packs/control-map.ts` | `certification.completed` joins the chain's entry kinds and the control map (AI Act Art. 14/15, NIST) |
| `apps/web` | `/autonomy` — Ladder (tier, autonomy rate, errors, days at tier, gate checklist, certify / ratify / demote), Suggestions (proposal inbox), Contention (who-is-on-this, locks, contact ledger, write conflicts), Usage & budget; `/autonomy/certifications/[id]` — the printable report; the Action Center's autonomy card now reads the ladder |

## How a consequential step meets the ladder

```
executor (pass.ts chain()):
  policy            → decision (ALLOW / REQUIRE_APPROVAL / DENY)
  autonomy (M10)    → AutonomyEngine.fold(ctx, decision, {modelId})
        R0 or DENY → unchanged
        budget halt reached → DENY (BUDGET_HALTED)
        no autonomy_state row → unchanged            ← "untiered blocks nothing"
        certified connector/model moved → demote to SUPERVISED now, and carry on
        error-rate / volume-spike over the window   → demote to SUPERVISED now
        floor := tier's floor (SUPERVISED/SHADOW/SUSPENDED: always; SAMPLED: 1-in-N;
                 AUTONOMOUS: none) ; novel input → floor := REQUIRE_APPROVAL for THIS call
        result := stricter(decision, floor)          ← never less strict than policy
  simulate → preVerify → approval → receipt:pre
  contention (M10B) → cooldown → COMMUNICATION locks → EXCLUSIVE_WRITE locks → ledger → declare
        blocked → stop with a reason a person (or the planner) can act on; nothing was sent
  → CALL → verify → receipt:post → release communication locks and write intents
run ends (any terminal state): releaseAllForRun
```

A tier change committed a moment ago takes effect on the *next call of a run already in flight*:
there is no cache between the state row and the fold.

## Decisions worth knowing

- **Enforcement is where the work is — and only there.** The UI shows a tier; the API changes
  one; a call is held back by `AutonomyEngine.fold` in the executor, reading the row fresh.
  The suite proves it the way the spec asks: change a tier through the API, with a run in flight,
  and watch the next call obey; and attempt every "UI-only bypass" (a spec edit, a template, the
  gateway) and see none of them raise a tier.
- **Promotion has one door.** `PromotionEngine.ratify(certification, person)`. It re-checks the
  whole gate *now* (connector version, fidelity, the tool's autonomy cap, that the pair has not
  moved since, that the certification is under 30 days old and was never acted on), moves one
  rung, and records the ratifier. There is no `setTier`, no import path, no route that sets one.
  `autonomy.request_promotion` (a workflow owner) can ask for a certification; only
  `autonomy.ratify` (owner, admin, compliance officer) can ratify.
- **Demotion has no inverse.** `DemotionEngine` exposes `demote` and nothing else; the transition
  table is append-only; the only way back up is a fresh certification and a person.
  A pair that never had a tier is not demoted (it has nothing to fall from) — the signal itself
  is already on record in the corpus and the incident tables.
- **Hysteresis is structural, not a timer.** Demotion is instant on any trigger; re-promotion
  needs a new certification over a window that, by construction, begins after the demotion's
  evidence. The gate compares the new window's connector/model versions to the previous
  certification's, so a flapping connector fails it.
- **SHADOW is enforced exactly like SUPERVISED.** The spec describes SHADOW as "runs, shows what
  it would do"; the platform has no side-effect-free replay of a live action, and silently
  *skipping* a requested action is worse than asking. So a SHADOW pair puts every action in front
  of a person and counts the decision as practice for the certification. The distinction is
  carried in the data (`from_tier`), not in the enforcement.
- **Certification is arithmetic over the corpus, not a replay.** module10.md §4 describes
  re-running past runs through M7's replay engine. Every number the gate needs — agreement, edit
  rate, error taxonomy, critical errors — is already a row in the override corpus (M8) joined to
  the M3/M6/M9 signals. The engine scores that directly, which is cheaper, reproducible, and the
  same arithmetic a risk committee can redo from the report. Deterministic replay (M7) remains
  the tool for "would this decision be different under today's policy" and is not on the path.
- **The report is signed before the row exists.** `certify` appends a `certification.completed`
  entry (the report as content, its digest in the payload) to the evidence chain and stores the
  entry id and hash. With no evidence plane, certification is refused: an unsigned report is a
  claim, not evidence. The printable viewer is the committee's copy; the chain entry is the
  original, verifiable with the offline verifier. (A signed PDF would be a rendering of the same
  bytes; the page prints cleanly instead of shipping a PDF toolchain.)
- **Locks are Postgres, not Valkey.** The spec's "Valkey leases + Postgres ledger" splits the
  arbiter across two systems; here the advisory transaction lock, the partial unique index and the
  waits table are one transaction, so "two holders" is impossible rather than improbable, and a
  crashed worker's lease simply expires. Deadlocks (R1 holds A wants B; R2 holds B wants A) are
  detected on every blocked acquire from the waits table and broken deterministically: the lower
  risk tier yields, ties go to the later start. Acquisition is in sorted key order so the common
  case never forms a cycle at all.
- **A duplicate contact is blocked, not discouraged.** The ledger check-and-record is atomic per
  identity (a transaction-scoped advisory lock on the normalized identity), so twenty agents racing
  for one person produce exactly one contact. An override (admin, with a reason) exempts *the run
  it names* and is stamped on the ledger row; it does not open the cooldown for anyone else.
- **Write conflicts are caught before the write.** A run declares the field it is about to set;
  a different value from a concurrent run is merged by a registered rule (e.g. union of tags),
  deferred (the lower-stakes write yields and replans), or escalated to a person. Last-write-wins
  is never the outcome.
- **Budget behaviors are enforced at two places.** At planning (`degrade` swaps to the economy
  model, `queue` holds the run, `halt` refuses) and, for `halt`, in the executor's fold, so a run
  already in flight stops at its next consequential step with `BUDGET_HALTED` rather than
  spending past the cap.
- **Plan gating follows D-09.** Running a certification and ratifying a promotion are
  `certificationLadder` surfaces (Teams and above). Enforcement, demotion, contention and budgets
  are not: a lower plan is still protected, and the way to make an agent stricter is never behind
  a paywall.
- **`workflow_key` is the agent id.** The codebase has no separate "workflow" entity and the
  spec's §11 says an agent definition is the versioned, certifiable unit — exactly what
  `agent_versions` already tracks. A pair is `(agent id, tool id)`.

## What the tests prove

| Suite (spec §19) | Where | Result |
|---|---|---|
| Certification correctness on seeded history — **blocking** | `packages/autonomy/test/autonomy.test.ts` | the corpus is scored; taxonomy, critical errors, pinned versions |
| Promotion gate: every condition, positive and negative — **blocking** | same | sample size (R1 vs R2/R3), agreement, edit rate, critical error, connector change, model change, DECLARED fidelity, autonomy cap; one rung at a time; acted on once |
| Automatic demotion on every trigger — **blocking** | same + `services/execution/test/autonomy.test.ts` | critical error, error rate, compensation failure, taint violation, version change, volume spike; **no restore path** |
| Enforcement at the executor, mid-run tier change — **blocking** | `services/execution/test/autonomy.test.ts` | a tier changed through the API takes effect on the next call of a live run |
| Autonomy cannot upgrade a policy disposition — **blocking** | `packages/autonomy/test/ladder.test.ts`, executor suite | AUTONOMOUS does not relax REQUIRE_APPROVAL or DENY |
| Novelty detection on out-of-distribution inputs | `packages/autonomy/test/autonomy.test.ts`, executor suite | new domain / length / time routes the call, not the tier |
| Lock acquisition p99 < 50 ms; no deadlock > 5 s | `packages/contention/test/contention.test.ts` | measured; cycles broken within the bound |
| Duplicate contact: zero inside cooldown | same | 20-way race → one contact; override exempts only its run |
| Write conflict resolution | same | merge, defer, escalate, person resolves |
| Budget cap enforcement | `services/execution/test/autonomy.test.ts`, `services/control/test/autonomy.test.ts` | degrade / queue / halt; halt stops an in-flight run; cap is the tenant's own table first |
| Multi-agent chaos: 20 agents on one entity | `packages/contention/test/contention.test.ts` | never two holders; everyone eventually gets a turn |
| Who may do what; every human action recorded | `services/control/test/autonomy.test.ts` | ratification needs `autonomy.ratify`; requester ≠ ratifier by role; lock release and contact override are admin-only and need a reason; each lands in `platform_events` and (for tier changes) the chain |
| The HTTP contract | `services/gateway/test/autonomy-routes.test.ts` | every §16 path documented, session-gated, validated at the edge; no route sets a tier |
| Isolation | `packages/db/test/isolation.test.ts` | the ten new tables are tenant-scoped and forced-RLS |

A defect the control-plane suite found and the contention suite now pins: an audited contact
override inserted its ledger row but the cooldown check still found the *earlier* contact and
blocked the run it was meant to allow. `ContactLedger.blocking` now exempts the run an override
names (`★ an override actually lets the overridden run through — and only that run`).

## What is not here

| Item | Why, and what stands in |
|---|---|
| ClickHouse analytics store (§17) | Usage is queried from the primary tables in a window; correct at this scale, with the same API a columnar store would back. Routing savings and per-token counts need the model gateway's metering — the API says so rather than inventing a number |
| Valkey leases | Postgres arbitrates (see above); Valkey stays the fast-revoke cache it already is |
| Signed PDF (§15.2) | The report is printable and its original is the chain entry; no PDF toolchain was added |
| Time-to-Undo on the ladder row (§15.1) | M6's `undo_metrics` already powers it on the Action Center card (`/admin/undo`); not repeated per pair |
| Proposal → policy draft in one click | Accepting a proposal records the decision and names the next step; authoring the policy is the normal, audited policy flow (§18) |
| P7 deployment modes, SCIM, SOC 2 Type II collection (§13) | Infrastructure and organizational work (Helm charts, customer-held KMS keys, auditors) with no code seam in this repository to build them into. M1's SSO and M7's customer-verifiable chain are the foundations the spec names |
| Marketplace (§14) | Deferred by the spec: "deliberately not now" |
| Cost attribution to business outcomes (§12) | Needs a workflow to *define* an outcome; there is no such field in the agent spec yet |
