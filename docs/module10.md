# Module 10 — Earned Autonomy, Contention & Enterprise Scale

> **D2 and D6, plus everything needed to sell to an organization.** This is where the flywheel
> closes: the override corpus becomes learned policy, workflows earn autonomy by evidence, and the
> product survives twenty agents operating on the same customer records.

| | |
|---|---|
| **Phase** | 2–4 (months 9–15+) |
| **Covers** | D2 (§8.2), D6 (§8.6), P2, P5, P6, P7 |
| **Depends on** | All modules — especially M8 (override corpus), M7 (signing), M6 (reversibility) |
| **Blocks** | Nothing. This is the module that makes the business work |
| **Estimate** | D2: 8–10 ew · D6: 4–5 ew · P2/P5/P7: 6–8 ew · P6: deferred |

---

## 1. Purpose & Scope

### 1.1 The metric that defines the company

> **Autonomy Rate** — the percentage of consequential actions completed with no human touch, at a
> bounded error rate.

Competitors report *actions blocked*. We report *work safely delegated*. Every board update leads
with this number, per customer, trending up. This module is what makes it move.

### 1.2 Sub-modules

| Part | Delivers | Phase |
|---|---|---|
| **10A — Earned Autonomy (D2)** | The ladder, certification by replay, learned policy, auto-demotion | 2 |
| **10B — Contention Control (D6)** | Entity locks, contact ledger, write reconciliation | 3 |
| **10C — Team & Enterprise (P2, P5, P7)** | Workspaces, shared agents, analytics, deployment modes, SSO/SCIM | 3 |
| **10D — Marketplace (P6)** | Installable agents and skills | 4+, deliberately deferred |

### 1.3 Out of scope

Building the override corpus (M8 captures it; this module consumes it) · the audit chain (M7 signs
certifications on request).

---

# Part 10A — Earned Autonomy (D2)

## 2. The Ladder

Every *(workflow × action type)* pair holds an **independent** autonomy tier. Granularity matters:
an agent may be autonomous for calendar updates and supervised for client emails, and treating
them as one setting destroys the whole idea.

| Tier | Agent behavior | Human behavior |
|---|---|---|
| `SHADOW` | Decides, does not act. Decision scored against what the human actually did | Works normally, unaware |
| `SUPERVISED` | Acts only after explicit approval | Approves every action |
| `SAMPLED` | Acts; 1-in-N routed for review | Reviews a sample |
| `AUTONOMOUS` | Acts; review by exception only | Handles escalations |
| `SUSPENDED` | Blocked pending investigation | Investigates |

```
        certification passed                sample agreement holds
 SHADOW ────────────────────► SUPERVISED ──────────────────► SAMPLED
   ▲                              ▲    │                        │
   │      re-certification        │    │  error / novelty       │ sustained
   └──────────────────────────────┴─ (demote) ◄──────────── AUTONOMOUS
                                       │                        │
                                       ▼  critical error /      │
                                  SUSPENDED ◄─ comp failure ────┘
                                             taint violation
```

**Asymmetry is deliberate:** earning trust is slow, evidence-based, and requires human
ratification. Losing it is instant and automatic.

## 3. Data Model

```sql
CREATE TABLE autonomy_state (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL,
  workflow_key    text NOT NULL,       -- agent name + objective template
  action_type     text NOT NULL,       -- tool id
  tier            text NOT NULL,       -- SHADOW|SUPERVISED|SAMPLED|AUTONOMOUS|SUSPENDED
  sample_rate     int,                 -- for SAMPLED: 1 in N
  since           timestamptz NOT NULL DEFAULT now(),
  certification_id uuid,
  ratified_by     uuid REFERENCES users(id),
  next_review_at  timestamptz,
  UNIQUE (tenant_id, workflow_key, action_type)
);

CREATE TABLE certifications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  workflow_key     text NOT NULL,
  action_type      text NOT NULL,
  window_from      timestamptz NOT NULL,
  window_to        timestamptz NOT NULL,
  sample_size      int NOT NULL,
  agreement_rate   numeric NOT NULL,
  edit_rate        numeric NOT NULL,
  critical_errors  int NOT NULL,
  error_taxonomy   jsonb NOT NULL,
  connector_versions jsonb NOT NULL,   -- pinned; a change invalidates
  model_versions   jsonb NOT NULL,     -- pinned; a change invalidates
  recommendation   text NOT NULL,      -- PROMOTE|HOLD|DEMOTE
  report_ref       text NOT NULL,      -- signed artifact (M7)
  signature        text NOT NULL,
  decided_by       uuid REFERENCES users(id),
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE autonomy_transitions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  workflow_key  text NOT NULL,
  action_type   text NOT NULL,
  from_tier     text NOT NULL,
  to_tier       text NOT NULL,
  direction     text NOT NULL,         -- PROMOTE|DEMOTE
  trigger       text NOT NULL,         -- certification|critical_error|comp_failure|
                                       -- taint_violation|novelty|version_change|manual
  evidence_json jsonb NOT NULL,
  actor_id      uuid,                  -- null for automatic demotion
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_proposals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  kind          text NOT NULL,         -- promote|demote|new_policy|tune_weights
  subject_json  jsonb NOT NULL,
  evidence_json jsonb NOT NULL,        -- the citations: which decisions support it
  proposed_change jsonb NOT NULL,
  confidence    numeric NOT NULL,
  state         text NOT NULL DEFAULT 'open',  -- open|accepted|dismissed|expired
  decided_by    uuid REFERENCES users(id),
  decided_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE novelty_baselines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  workflow_key  text NOT NULL,
  action_type   text NOT NULL,
  feature_stats jsonb NOT NULL,        -- distribution captured at certification
  computed_at   timestamptz NOT NULL DEFAULT now()
);
```

## 4. Certification by Replay

A workflow is not promoted by opinion. It is promoted by evidence.

```
1. Select historical cases where the human outcome is known
     · SHADOW    → agent decisions vs. what the human actually did
     · SUPERVISED → approvals, rejections, and edits from M8's corpus
2. Replay each through M7's deterministic replay (DRY mode, no side effects)
3. Score:
     agreement_rate  — agent decision matched the human outcome
     edit_rate       — human modified before release (M8 edit_diff)
     error_taxonomy  — classify disagreements; identify critical-class errors
4. Capture connector + model versions (pinned)
5. Emit a signed certification report (M7 signing service)
```

```
Workflow: client-comm-draft · Action: gmail.send (R2)
  Shadow period:            62 days
  Decisions evaluated:      1,247
  Agreement with human:     96.3%   (threshold 95%)
  Human edits before send:  18.1%   (threshold <25%)
  Critical errors:          0       (threshold 0)

  Error taxonomy
    tone mismatch            27   non-critical
    missing context          11   non-critical
    wrong recipient           0   CRITICAL — none observed
    unsupported claim         8   non-critical (all caught by M9 groundedness)

  Recommendation: PROMOTE  SUPERVISED → SAMPLED (1 in 5)
  Pinned: gmail-connector v3, claude-opus-5, prompt v7, policy bundle v11
```

### 4.1 Promotion gate

**All** must hold:

- Minimum sample size (default 200 per action type; higher for `R2`/`R3`)
- Agreement ≥ threshold (default 95%, tier-dependent)
- Edit rate ≤ threshold (default 25%)
- **Zero critical-class errors, ever**
- Connector and model versions unchanged since certification
- Simulation fidelity is not `DECLARED` for this tool (M6 §5.6)
- **Explicit human ratification** — promotion is never automatic

## 5. Learned Policy from Override Telemetry

Administrators are poor at authoring policy up front. The system proposes it from evidence.

```
"You have approved 47 of 47 invoice approvals under $500 in the last 90 days.
 Promote gmail.send/invoice-ack to autonomous for this action type?"
      Evidence: 47 decisions · median latency 6s · 0 edits · 0 rejections
      [ Accept ]  [ Dismiss ]  [ Show all 47 ]

"3 of the last 10 external sends to first-contact domains were edited before
 release. Demote to SUPERVISED for new domains?"
      Evidence: 3 edits, all adding a compliance disclaimer
      [ Accept ]  [ Dismiss ]  [ Show the edits ]
```

**Rules:**
- Every proposal cites its evidence and links to the underlying decisions.
- Proposals **never auto-apply.** A human always ratifies a change in autonomy.
- Dismissals are training signal — a repeatedly dismissed proposal class stops being generated.
- Proposals expire; stale evidence produces no recommendation.

**Mining the edit diffs** (M8 `edit_diff_json`) is the highest-value analysis in the product:
when three approvers all add the same disclaimer, that is a missing policy, not three
coincidences. Group edits by field and by structural change, not by rendered text.

## 6. Automatic Demotion

Immediate and automatic on:

| Trigger | Source |
|---|---|
| Error rate crossing threshold over a rolling window | M9 verification + M8 rejections |
| **Any critical-class error, ever** | Error taxonomy |
| Compensation failure | M6 |
| Taint violation | M3 |
| Statistical novelty — inputs materially unlike the certification distribution | `novelty_baselines` |
| Connector or model version change | Version pinning |
| Anomalous volume spike | Usage telemetry |

Demotion notifies the workflow owner with the triggering evidence. **Re-promotion requires a fresh
certification run** — there is no "restore previous tier" button.

### 6.1 Novelty detection

At certification, capture the input distribution (recipient domains, content length, entity types,
time of day, value ranges). At runtime, score each input against that baseline; a materially
out-of-distribution input is handled at a lower tier for that action only — the workflow is not
demoted wholesale, but that specific action gets a human.

This is the mechanism that makes autonomy safe for the long tail: the agent stays autonomous on the
work it has demonstrated, and asks on the work it has not.

## 7. Enforcement

**Autonomy tier is enforced at the executor, not the UI.** A tier change takes effect mid-run: a
run in flight that is demoted routes its next consequential action to approval.

Interaction with policy (M5): **autonomy may only downgrade a disposition, never upgrade it.** If
policy says `REQUIRE_APPROVAL`, `AUTONOMOUS` does not override it. Autonomy relaxes the *default*
disposition; it never overrides an explicit policy.

---

# Part 10B — Contention Control (D6)

## 8. The Problem

Once an organization runs twenty agents, two will touch the same customer record, and three will
email the same prospect the same week. Nobody solves this. It appears exactly when a deployment
starts to scale — which is renewal time.

## 9. Data Model

```sql
CREATE TABLE entity_locks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  entity_key     text NOT NULL,        -- 'crm:account:8812', 'client:44'
  mode           text NOT NULL,        -- SHARED_READ|EXCLUSIVE_WRITE|COMMUNICATION
  holder_run_id  uuid NOT NULL,
  holder_agent_id uuid NOT NULL,
  intent         text NOT NULL,        -- human-readable: "sending quarterly review"
  acquired_at    timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz NOT NULL,
  UNIQUE (tenant_id, entity_key, mode)
    WHERE mode IN ('EXCLUSIVE_WRITE','COMMUNICATION')
);

CREATE TABLE contact_ledger (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  external_identity text NOT NULL,     -- normalized email / phone / handle
  channel           text NOT NULL,     -- email|slack|calendar
  contacted_at      timestamptz NOT NULL,
  by_run_id         uuid NOT NULL,
  by_agent_id       uuid NOT NULL,
  on_behalf_of      uuid NOT NULL,
  relationship_type text,              -- prospect|client|vendor|internal
  cooldown_until    timestamptz NOT NULL
);
CREATE INDEX ON contact_ledger (tenant_id, external_identity, contacted_at DESC);

CREATE TABLE write_conflicts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  entity_key    text NOT NULL,
  field         text NOT NULL,
  proposals     jsonb NOT NULL,        -- [{run_id, value, risk_tier, at}]
  resolution    text,                  -- merged|escalated|deferred
  resolved_by   uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

## 10. Mechanics

### 10.1 Entity locking

Advisory locks on **business entities**, not database rows — the contention is semantic.

| Mode | Meaning |
|---|---|
| `SHARED_READ` | Multiple readers permitted |
| `EXCLUSIVE_WRITE` | One writer per entity |
| `COMMUNICATION` | **Only one agent may contact a given human at a time** |

Lease-based with heartbeat; automatic release on run termination; canonical acquisition order to
prevent deadlock; deterministic victim selection on a detected cycle — **the lower-risk run
yields**, ties broken by run start time.

Acquisition p99 target: < 50ms. No deadlock persists beyond 5s.

### 10.2 Duplicate outreach suppression

A global contact ledger per external human. Policy-enforced cooldowns per relationship type
(e.g. prospect: 5 days; client: 1 day; internal: none). A second agent attempting contact inside
the cooldown is **blocked and told who holds the relationship**:

> Cannot email peter@acme.com — the *Quarterly Review* agent contacted them 6 hours ago
> on behalf of Sarah. Cooldown ends in 4 days. [Request override]

### 10.3 Write reconciliation

Last-write-wins is unacceptable. Conflicts are detected pre-commit and resolved by:

1. **Merge by policy** where fields are non-overlapping or a merge rule exists.
2. **Escalate to a human** with both proposals shown side by side (via M8's packet renderer).
3. **Defer and replan** — the lower-priority write yields and replans against the new state.

### 10.4 "Who else is on this account"

A visible surface: for any entity, every agent and human currently acting on it, with intent and
lock state. Operationally mundane; exactly what makes a large deployment survivable.

---

# Part 10C — Team & Enterprise (P2, P5, P7)

## 11. P2 — Team Workspaces & Shared Agents

- Workspaces scope memory, connectors, policy, and agents (schema from M1).
- Shared agents owned by a workspace with an explicit accountable owner.
- Agent definitions versioned and diffable; **changing one resets certification** (§6).
- Per-agent permission sets, independent of the creator's permissions.

**Team templates** (PROJECT.md §9.2), each shipping with pre-built policy bindings — and **every
one starts at `SHADOW`**, template or not:

| Template | Flow |
|---|---|
| Sales | Lead research → qualification → CRM update → follow-up |
| Operations | Reports → workflows → scheduling → monitoring |
| HR | Candidate coordination → scheduling → communication |
| Marketing | Research → content workflow → campaign analysis |
| Management | Executive summaries → meeting prep → follow-ups |

## 12. P5 — Usage Analytics & Cost Controls

Per user, agent, workflow, and connector: model usage, tokens, estimated cost, success rate,
latency, routing savings (from LiteLLM's spend tracking, M4/TECHSTACK §10.1).

**Hard budget caps** with configurable breach behavior: degrade to cheaper models, queue, or halt.
Anomalous-spend alerts. Cost attribution to business outcomes where the workflow defines one.

> **Pricing discipline (PROJECT.md §22):** we price on governed actions and oversight seats, never
> on tokens. Routing savings are shown because customers like the number — it is never a pricing
> basis. That only holds if these caps are enforced; an ungoverned agent loop is the fastest way
> to invert unit economics.

## 13. P7 — Deployment Modes

| Mode | Shape | Phase |
|---|---|---|
| Multi-tenant SaaS | Managed k8s, regional clusters for residency | 1 |
| Single-tenant hosted | Dedicated namespace + DB + **customer-held KMS key** | 3 |
| Private VPC | Helm chart into the customer's cluster; our control plane, their data plane | 3 |
| Air-gapped | Full chart + vLLM + open weights, no external egress | 4+ |

Also in this part: **SSO/SAML depth and SCIM provisioning** (M1 laid the foundation), custom
policy packs per vertical, and SOC 2 Type II — for which the plane separation (M1) and audit chain
(M7) already do most of the work.

**Signing keys are customer-controlled in single-tenant and above.** That is the point of
independent verifiability (M7) — a customer who cannot hold their own key cannot fully trust the
evidence.

---

# Part 10D — Marketplace (P6, deferred)

## 14. Deliberately Not Now

Organizations install specialized agents and skills — Sales, Research, Finance, HR, Meeting,
Customer Support. Each marketplace agent must ship declarations, compensators, and a certification
report, and **installs at `SHADOW` regardless of publisher**. Third-party connector code runs under
gVisor/Firecracker isolation (TECHSTACK §9).

**Revisit only after 50 paying customers and a stable connector SDK.** A marketplace requires a
developer ecosystem we will not have for 24+ months, and shipping it early signals a platform we
cannot support.

---

## 15. Frontend

### 15.1 Autonomy Dashboard (Action Center, shell built in M8)

Per workflow × action type: current tier, autonomy rate, error rate, mean Time-to-Undo, days at
tier, promotion eligibility with the gate checklist, and pending proposals.

```
client-comm-draft
  gmail.draft    AUTONOMOUS   98.2% autonomous   0 errors/30d   ✓ healthy
  gmail.send     SAMPLED 1:5  81.0% autonomous   2 edits/30d    ⬆ eligible for promotion
  gcal.create    SUPERVISED   0% autonomous      —              ⏳ 62/200 samples
```

### 15.2 Certification report viewer

The full report as it will be signed and filed — agreement, edit rate, error taxonomy with
examples, pinned versions, recommendation. Exportable as a signed PDF for a risk committee.

### 15.3 Proposal inbox

Learned-policy proposals with evidence, accept/dismiss, and a link to every supporting decision.

### 15.4 Contention views

"Who else is on this account" per entity; active locks; contact ledger with cooldown status;
write-conflict resolution UI.

### 15.5 Analytics

Usage and cost by dimension; budget consumption; routing savings; anomaly alerts.

## 16. APIs

```
GET    /v1/autonomy                          # tiers per workflow × action
GET    /v1/autonomy/:workflow/:action
POST   /v1/autonomy/certify                  # run certification
GET    /v1/certifications/:id
GET    /v1/certifications/:id/report         # signed artifact
POST   /v1/autonomy/promote                  # human ratification (required)
POST   /v1/autonomy/demote                   # manual demotion
GET    /v1/autonomy/transitions              # full history
GET    /v1/autonomy/proposals
POST   /v1/autonomy/proposals/:id/decide

GET    /v1/entities/:key/activity            # who else is on this
GET    /v1/locks
POST   /v1/locks/:id/release                 # admin override
GET    /v1/contact-ledger?identity=
POST   /v1/contact-ledger/override           # audited exception
GET    /v1/write-conflicts
POST   /v1/write-conflicts/:id/resolve

GET    /v1/usage                             # analytics
GET    /v1/budgets  PUT /v1/budgets

Webhooks: autonomy.promoted · autonomy.demoted · certification.completed ·
          proposal.created · contention.blocked · budget.exceeded
```

## 17. Technology

| Concern | Choice | License |
|---|---|---|
| Certification replay | M7 replay engine (DRY mode) | ours |
| Eval assertions | DeepEval | Apache-2.0 |
| Report signing | M7 signing service (ML-DSA) | MIT |
| Statistics | Plain TypeScript — agreement, distributions, thresholds | ours |
| Novelty detection | Feature statistics + distance; **not** an opaque model | ours |
| Locks | Valkey leases + Postgres for durable ledger | BSD-3 / PostgreSQL |
| Analytics store | ClickHouse (shared with SigNoz) | Apache-2.0 |
| Spend data | LiteLLM | MIT |
| Deployment | Helm, Argo CD, OpenTofu, k3s, vLLM | Apache-2.0 / MPL-2.0 |

**Keep the statistics transparent.** Like the risk function (M5), a certification score must be
readable by a risk committee. No opaque model decides whether an agent gets to act unsupervised.

## 18. Security

| Control | Implementation |
|---|---|
| Promotion requires ratification | Never automatic; ratifier recorded and audited |
| Certification integrity | Reports signed by M7; pinned versions prevent stale certification |
| Version invalidation | Connector/model/policy change invalidates certification automatically |
| Demotion cannot be suppressed | Automatic demotion has no override path; only re-certification restores |
| Enforcement point | Executor, not UI; tested by attempting a UI-only bypass |
| Lock override | Admin-only, audited, requires a reason |
| Contact override | Audited exception with a reason; visible in the ledger |
| Proposal manipulation | Proposals are read-only artifacts; accepting one creates a normal, audited policy change |

## 19. Testing

| Suite | Gate |
|---|---|
| Certification correctness on seeded history | **Blocking** |
| Promotion gate — every condition, positive and negative | **Blocking** |
| **Automatic demotion on every trigger** | **Blocking** |
| Enforcement at executor (mid-run tier change) | **Blocking** |
| Autonomy cannot upgrade a policy disposition | **Blocking** |
| Novelty detection on out-of-distribution inputs | Blocking |
| Lock acquisition p99 < 50ms; no deadlock > 5s | Blocking |
| Duplicate contact suppression in production | **Zero duplicates inside cooldown** |
| Write conflict resolution | Blocking |
| Budget cap enforcement | Blocking |
| Multi-agent chaos: 20 agents on one entity | Blocking |

## 20. Acceptance Criteria

- [ ] Autonomy tier is independent per workflow × action type
- [ ] Certification runs against real history and produces a signed report
- [ ] Promotion requires all gate conditions **and** explicit human ratification
- [ ] Demotion is automatic and immediate on every trigger in §6
- [ ] Re-promotion requires fresh certification — no "restore" path
- [ ] Tier is enforced at the executor; a mid-run change takes effect
- [ ] Autonomy can only downgrade a policy disposition, never upgrade it
- [ ] Learned proposals cite evidence and never auto-apply
- [ ] Novelty detection routes out-of-distribution inputs to a human without demoting the workflow
- [ ] Zero duplicate outbound contacts inside cooldown, measured in production
- [ ] Lock acquisition p99 < 50ms; no deadlock persists beyond 5s
- [ ] "Who else is on this account" is accurate under concurrent load
- [ ] Budget caps enforced with configured breach behavior
- [ ] Single-tenant deployment works with a customer-held signing key
- [ ] **At least one workflow promoted from `SHADOW` to `SAMPLED` at a paying customer, on the
      strength of a certification report** ← the Phase 2 exit criterion

## 21. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Customers never promote past SUPERVISED** | **Existential — PROJECT.md §24** | This is *the* thesis test. If no design partner promotes a workflow within 6 months, the positioning is wrong. Treat the first promotion as the company's most important milestone |
| Insufficient history for certification | Cannot promote anything | SHADOW mode from day one on every workflow; certification needs months of data — start accumulating in Phase 1 |
| Thresholds are guesses | Premature or blocked promotion | Calibrate per action type with design partners; make them tenant-tunable within bounds |
| Demotion thrashing | Workflows oscillate; users lose confidence | Hysteresis: demote fast, require sustained evidence to re-promote; rate-limit transitions |
| Novelty detection too sensitive | Everything goes to a human; autonomy rate collapses | Tune on real distributions; measure the escalation rate as a product metric |
| Contact ledger identity resolution | Missed duplicates across aliases | Normalize aggressively; accept false positives over false negatives |
| Marketplace built too early | Unsupportable platform | Hard gate: 50 paying customers and a stable SDK |

## 22. Deliverables

- [ ] `services/control/autonomy` — ladder, enforcement, transitions
- [ ] Certification engine on M7 replay; signed reports
- [ ] Learned-policy proposal generator mining M8's override corpus and edit diffs
- [ ] Novelty baselines and runtime scoring
- [ ] Automatic demotion wired to M3, M6, M8, M9 signals
- [ ] `services/control/contention` — locks, contact ledger, write reconciliation
- [ ] P2: workspaces, shared agents, five team templates
- [ ] P5: usage analytics, budget caps, anomaly alerts
- [ ] P7: single-tenant and private VPC Helm charts; SSO/SAML depth; SCIM
- [ ] Autonomy dashboard, certification viewer, proposal inbox, contention views, analytics
- [ ] Migrations for all tables in §3 and §9
- [ ] SOC 2 Type II evidence collection begun

---

## 22.1 Tier exposure and the margin metric (PROJECT.md §22.1, §22.6)

**Autonomy on self-serve tiers** collapses the five-tier ladder into a single user-facing control
— "Ask me before sending", on or off — while the **same state machine runs underneath**. A
self-serve account is effectively pinned between `SUPERVISED` and `SAMPLED`. Certification,
novelty detection, and automatic demotion all still operate; the user simply sees a nudge:

> "You have approved 30 of 30 calendar invites. Stop asking about these?"

That is the learned-policy proposal engine (§5) with one button instead of a report. Full
certification, signed reports, and the promotion gate stay Teams/Enterprise surfaces.

**P5 additions for self-serve** — build with the first paying SMB account, not later:

- **Hard budget caps per account.** Breach degrades to a cheaper model or queues. It **never bills
  a surprise and never silently upgrades the model.**
- **Per-tier contribution margin** as a first-class internal metric: revenue minus inference,
  storage, and support cost per account, by tier. **A tier that cannot reach positive margin at
  target usage does not ship** (§22.6).
- **Billing integration** against `tenants.billing_ref` (M1): metered governed actions, seats,
  plan changes, dunning.

Cross-check with M5: C4 routing policy is what makes those margins achievable. If contribution
margin is negative at target usage, the fix is routing and caps — **never** removing undo (D-10).

---

## 23. Closing the Loop

With this module, the flywheel from PROJECT.md §1.4 is complete and observable in the product:

```
   more reversibility (M6)  ──>  lower risk score (M5)  ──>  higher autonomy tier (M10)
           ▲                                                          │
           │                                                          ▼
   better compensators  <──  more override data (M8)  <──  more actions executed (M4)
```

Every subsequent quarter of engineering should be spendable on one of two things: **moving an
action up the reversibility ladder** (R3→R2→R1), or **raising an autonomy tier with evidence**.
Both increase the Autonomy Rate. Anything that does not do one of those is, by definition, not the
core product.
