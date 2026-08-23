# Module 8 — Approval, Escalation & Action Center

> **D5 plus the Action Center.** Human-in-the-loop dies of approval fatigue — always. An approval
> workflow humans rubber-stamp is *worse* than none, because it manufactures false evidence of
> oversight. This module treats the approval as a product surface, not a form.

| | |
|---|---|
| **Phase** | 1–2 (months 7–9) |
| **Covers** | D5 (PROJECT.md §8.5), Action Center (§6.2), threat T12 |
| **Depends on** | M5 (approval decisions + roles), M6 (blast radius, holds), M7 (evidence digest) |
| **Blocks** | M10 (override corpus is captured here) |
| **Estimate** | 6–8 engineer-weeks |

---

## 1. Purpose & Scope

### 1.1 The problem

McKinsey's 2026 work found only about one in three organizations reach governance maturity level
3+ while deploying increasingly autonomous agents anyway. The gap is operational, not conceptual:
the approval step exists, and humans stop reading it.

That failure mode is also a regulatory exposure. EU AI Act Article 14 requires oversight that is
*genuine* — trained, measurable, provable. An approver clicking through in 1.2 seconds without
opening the evidence is not oversight, and a receipt proving they did so is evidence *against* the
deployer.

### 1.2 The design target

> **Median approval in under 10 seconds — while the approver actually reads the material.**

Those two goals are in tension, and resolving the tension *is* the product work. The answer is not
a faster form; it is showing less, better: the simulated effect instead of a plan, a recommended
default, the evidence one tap away, and batching so attention is spent in one place rather than
scattered across the day.

### 1.3 In scope

- Decision packets (server-rendered, hashed for M7)
- Approval inbox with keyboard-driven queue and bulk actions
- Batching, notification budgets, urgency override
- Expiry and declared fallbacks
- Delegation, role routing, dual approval with separation of duties, escalation chains
- Mobile: approve, reject, and **revoke** from a push notification
- Approval telemetry — the override corpus (M10's moat)
- Rubber-stamp detection (T12)
- The full Action Center

### 1.4 Out of scope

Deciding *that* approval is required (M5) · autonomy tiers (M10) · the hold mechanism itself (M6 —
this module renders and controls it).

---

## 2. Dependencies

| From | Needs |
|---|---|
| M5 | `REQUIRE_APPROVAL(role)`, `REQUIRE_DUAL_APPROVAL`, reason chains, risk explanation |
| M6 | Blast radius, hold state, revoke endpoint, compensation status |
| M7 | Evidence digest capture; approval receipts written to the chain |
| M4 | `approvalGate` extension point (pauses the Temporal workflow on a signal) |

---

## 3. Architecture

```
   M5 decision: REQUIRE_APPROVAL
            │
            ▼
┌────────────────────────────────────────────────┐
│ Approval Orchestrator (control plane)          │
│  · resolve approver (role → user, delegation)  │
│  · render decision packet server-side          │
│  · hash rendered payload → evidence_digest     │
│  · batch or interrupt (urgency rules)          │
│  · set expiry + fallback                       │
└──────────┬─────────────────────────────────────┘
           │
     ┌─────┴──────┬──────────────┐
     ▼            ▼              ▼
  Web inbox   Push (mobile)   Email digest
     │            │              │
     └─────┬──────┴──────────────┘
           ▼
    decision recorded  ──▶ Temporal signal (M4 resumes)
           │
           ├──▶ approval receipt (M7)
           └──▶ override telemetry (M10 corpus)
```

**Server-side rendering is a requirement, not a preference.** The packet must be hashed to prove
what was shown (M7 §15). A client-assembled view cannot be attested.

---

## 4. Data Model

```sql
-- ============ Approval requests ============
CREATE TABLE approval_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  run_id         uuid NOT NULL,
  action_id      uuid NOT NULL REFERENCES actions(id),
  node_id        uuid NOT NULL,
  approver_role  text NOT NULL,
  assigned_to    uuid REFERENCES users(id),
  delegated_from uuid REFERENCES users(id),
  packet_json    jsonb NOT NULL,            -- the rendered packet
  packet_digest  text NOT NULL,             -- → M7 evidence_digest
  urgency        text NOT NULL DEFAULT 'normal',   -- normal|urgent
  batch_id       uuid,
  requires_dual  boolean NOT NULL DEFAULT false,
  expires_at     timestamptz NOT NULL,
  fallback       text NOT NULL,             -- AUTO_REJECT|AUTO_APPROVE|ESCALATE
  fallback_role  text,
  state          text NOT NULL DEFAULT 'pending',
                 -- pending|approved|rejected|expired|escalated|superseded|cancelled
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE INDEX ON approval_requests (assigned_to, state, expires_at);
CREATE INDEX ON approval_requests (tenant_id, state);

-- ============ Decisions — THE OVERRIDE CORPUS (PROJECT.md §1.5) ============
CREATE TABLE approval_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  request_id        uuid NOT NULL REFERENCES approval_requests(id),
  action_id         uuid NOT NULL,
  approver_id       uuid NOT NULL REFERENCES users(id),
  decision          text NOT NULL,          -- approve|approve_with_edits|reject|question
  reason            text,
  edited            boolean NOT NULL DEFAULT false,
  edit_diff_json    jsonb,                  -- WHAT they changed, not just that they did
  latency_ms        int NOT NULL,
  evidence_opened   boolean NOT NULL,
  evidence_dwell_ms int,
  surface           text NOT NULL,          -- web|mobile|email
  packet_digest     text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- Never delete a row. This table is the moat.

-- ============ Batching & notification budget ============
CREATE TABLE approval_batches (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  scheduled_at timestamptz NOT NULL,
  delivered_at timestamptz,
  item_count   int NOT NULL DEFAULT 0,
  state        text NOT NULL DEFAULT 'accumulating'
);

CREATE TABLE notification_budget (
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL,
  day         date NOT NULL,
  sent        int  NOT NULL DEFAULT 0,
  budget      int  NOT NULL DEFAULT 12,
  PRIMARY KEY (tenant_id, user_id, day)
);

-- ============ Delegation ============
CREATE TABLE delegations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL,
  from_user  uuid NOT NULL REFERENCES users(id),
  to_user    uuid NOT NULL REFERENCES users(id),
  role_scope text,
  starts_at  timestamptz NOT NULL,
  ends_at    timestamptz NOT NULL,
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ Rubber-stamp monitoring (T12) ============
CREATE TABLE approval_quality (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  approver_id       uuid NOT NULL,
  window_start      date NOT NULL,
  decisions         int NOT NULL,
  median_latency_ms int NOT NULL,
  p10_latency_ms    int NOT NULL,
  evidence_open_rate numeric NOT NULL,
  edit_rate         numeric NOT NULL,
  reject_rate       numeric NOT NULL,
  flag              text,                   -- null|IMPLAUSIBLE_SPEED|NO_EVIDENCE_REVIEW
  UNIQUE (tenant_id, approver_id, window_start)
);
```

---

## 5. Backend

### 5.1 The decision packet

One screen. Everything needed, nothing more.

```jsonc
{
  "what": {                              // from M6 simulation — effects, not prose
    "summary": "Send 1 email to peter@acme.com (external)",
    "effects": [ /* blast radius entries */ ],
    "reversibility": "R2",
    "hold_window_ms": 900000
  },
  "why": {
    "objective": "Respond to Acme's partnership question",
    "trigger": "chat · requested by you at 10:02",
    "reasoning": "Their email asked for revised terms; the draft cites the approved schedule."
  },
  "evidence": {
    "sources": [ { "id": "gmail:msg_44", "taint": "UNTRUSTED", "excerpt": "..." } ],
    "unsupported_claims": [ { "text": "we can start in Q4", "reason": "no trusted source" } ],
    "provenance_graph_ref": "..."
  },
  "risk": { "score": 68, "tier": "HIGH", "explanation_ref": "..." },   // M5 panel
  "policy": { "id": "external-comms-supervision", "citation": "FINRA 2210",
              "reason_chain": [ /* M5 */ ] },
  "recommended": "approve",              // pre-selected default
  "if_you_do_nothing": {
    "at": "2026-08-22T14:02:00Z",
    "outcome": "AUTO_REJECT — the email will not be sent and the run will end"
  },
  "actions": ["approve", "approve_with_edits", "reject", "reject_with_reason", "question"]
}
```

**Every field earns its place.** Anything not needed to decide is one tap away, not on the screen.
The packet is rendered server-side and hashed — `packet_digest` goes into the M7 receipt.

### 5.2 "What happens if you do nothing"

Stated explicitly on every packet. Nothing hangs forever; nothing silently proceeds.

| Fallback | When permitted |
|---|---|
| `AUTO_REJECT` | Default, always available |
| `AUTO_APPROVE` | **Only Low tier, only if policy explicitly permits.** Never for `EXTERNAL` egress |
| `ESCALATE(role)` | Routes to the next approver in the chain |

### 5.3 Batching and rhythm

- Approvals accumulate into **review moments** (configurable, default 09:00 / 13:00 / 17:00 local).
- `urgency: urgent` breaks the batch — set by policy (Critical tier) or by a short expiry.
- A batch renders as a queue with keyboard navigation (`j`/`k`, `a`, `r`, `e`, `?`) and bulk
  actions on **homogeneous** groups only — bulk-approving heterogeneous actions is how
  rubber-stamping starts, so the UI refuses it.
- **Notification budget per user per day is enforced.** Exceeding it is tracked as a product bug,
  not an operational fact. When the budget is exhausted, remaining items wait for the next batch
  and the tenant's owner is alerted that the workflow is generating too many interruptions.

### 5.4 Routing, delegation, dual approval

- Role → user resolution honors active delegations (out-of-office).
- Unresponsive primary → escalation chain after a configurable fraction of the expiry window.
- **Dual approval enforces separation of duties**: the requester can never be an approver, and the
  two approvers must be distinct. Enforced in the service, not the UI.
- If the assigned approver lacks the required role at decision time (role changed since
  assignment), the decision is rejected and re-routed — authorization is checked at decide time,
  not assign time.

### 5.5 Approval telemetry — the override corpus

Every interaction feeds M10. Captured on **every** decision:

| Field | Why it matters |
|---|---|
| `decision` | The label |
| `latency_ms` | Fast = confident or careless; the distribution distinguishes them |
| `evidence_opened` + `evidence_dwell_ms` | Whether oversight was genuine (Art. 14) |
| `edited` + **`edit_diff_json`** | **What** they changed — the highest-value signal in the system |
| `reason` on reject | Free text, mined for policy proposals |
| `surface` | Mobile decisions are systematically faster; normalize by surface |
| `packet_digest` | Ties the decision to exactly what was shown |

> `edit_diff_json` is the single most valuable column in the product. "The human approved but
> changed the greeting and removed a price claim" teaches the system far more than a binary
> approval. Capture the diff structurally — before/after per field — never as a rendered string.

### 5.6 Rubber-stamp detection (T12)

Nightly job computing per-approver windows:

| Flag | Condition |
|---|---|
| `IMPLAUSIBLE_SPEED` | p10 latency below a plausible reading time for the packet's content length |
| `NO_EVIDENCE_REVIEW` | Evidence-open rate below threshold on HIGH/CRITICAL items |

Flags surface to the compliance officer — **not** as an accusation, as a signal that either the
packets are too noisy or the routing is wrong. Both are usually product problems. The response
should first be "why are they getting so many of these," not "why isn't this person reading."

Product-level target: **evidence-open rate > 60%.** Below that, oversight is theatre and the
Article 14 claim is unsupportable.

---

## 6. Frontend

### 6.1 Approval inbox (`/approvals`)

Queue with keyboard-first navigation. Each item shows the packet; the queue shows type, risk tier,
expiry countdown, and requester. Filters by tier, agent, expiry. Grouping by homogeneous action
type enables bulk action.

Empty state matters: "Nothing needs you right now — 14 actions ran autonomously today"
reinforces the autonomy narrative rather than showing a blank page.

### 6.2 Packet renderer

```
┌───────────────────────────────────────────────────────────────┐
│ Send email to peter@acme.com                        HIGH · 68 │
│ ────────────────────────────────────────────────────────────  │
│ WHAT                                                          │
│   ✉ 1 email → acme.com (external)      R2 · 15 min to recall  │
│                                                               │
│ WHY                                                           │
│   Their email asked for revised terms; the draft cites the    │
│   approved schedule.                                          │
│                                                               │
│ ⚠ 2 claims unsupported by a trusted source     [Show me]      │
│ ⚠ Content derived from an external email       [Provenance]   │
│                                                               │
│ POLICY  external-comms-supervision · FINRA 2210               │
│                                                               │
│ If you do nothing by 14:02 → not sent, run ends               │
│ ────────────────────────────────────────────────────────────  │
│ [ Approve ]  [ Edit & approve ]  [ Reject ]  [ Ask ]          │
└───────────────────────────────────────────────────────────────┘
```

Recommended action pre-selected. Evidence one tap away, and opening it is measured.

### 6.3 Mobile (React Native + Expo)

Three actions only: **approve**, **reject**, **revoke a held action**.

**Asymmetric authentication, deliberately:**

| Action | Requires |
|---|---|
| Revoke | Nothing — one tap from the notification |
| Reject | Nothing |
| Approve | Biometric / device authentication |

The safe action is always the fastest. Approving from a phone is a real decision and is
authenticated; stopping something is not.

### 6.4 Action Center (`/action-center`) — complete here

**Today's Executive Brief** — urgent messages, upcoming meetings, pending tasks, follow-ups due,
decisions awaiting you. Generated on a schedule so it is ready before the user asks.

**Active AI Tasks** — grouped by state: `RUNNING`, `AWAITING_APPROVAL`, `HELD` (with live
countdown), `COMPLETED`, `FAILED`, `COMPENSATED`, `NEEDS_ATTENTION`. Elapsed time, current step,
risk tier, time remaining in hold.

**Security Center** — risk events, blocked actions, approval requests, access activity, policy
violations, **taint violations** (M3), **compensation failures** (M6). Filterable by agent, user,
connector, severity.

**AI Usage** — models, tokens, estimated cost, task performance, routing savings. Per user, agent,
workflow. Budget consumption against caps.

**Autonomy Dashboard** — per workflow: current tier, autonomy rate, error rate, mean Time-to-Undo,
promotion eligibility, pending proposals. *(Populated by M10; the surface is built here.)*

**Verification status** — chain intact, last anchor (M7).

### 6.5 Component inventory

| Component | Notes |
|---|---|
| `DecisionPacket` | Server-rendered; the hashed artifact |
| `ApprovalQueue` | Keyboard navigation, homogeneous bulk grouping |
| `ExpiryCountdown` | Shared with M6's hold countdown |
| `EvidenceDrawer` | Opening it is instrumented |
| `EffectSummary` | From M6 blast radius |
| `BriefCard` · `TaskStateGroup` · `SecurityEventRow` · `UsageChart` · `AutonomyTile` | Action Center |

---

## 7. APIs

```
GET    /v1/approvals                      # queue for the caller
GET    /v1/approvals/:id
GET    /v1/approvals/:id/packet           # server-rendered packet + digest
POST   /v1/approvals/:id/decide           # { decision, reason?, edits? }
POST   /v1/approvals/:id/question         # ask without deciding; pauses expiry once
GET    /v1/approvals/batches/current

POST   /v1/delegations
GET    /v1/delegations
DELETE /v1/delegations/:id

GET    /v1/action-center/brief
GET    /v1/action-center/tasks            # grouped by state
GET    /v1/action-center/security
GET    /v1/action-center/usage
GET    /v1/action-center/autonomy         # M10 fills the data

GET    /v1/approval-quality               # rubber-stamp monitoring (COMPLIANCE_OFFICER)

Webhooks: approval.requested · approval.decided · approval.expired ·
          approval.escalated · approval.quality_flag
```

---

## 8. Key Flows

### 8.1 Approval, happy path

```
M5 → REQUIRE_APPROVAL(REGISTERED_PRINCIPAL)
  → resolve approver (honor delegation)
  → render packet server-side; hash → packet_digest
  → batch or interrupt by urgency; check notification budget
  → notify (push/web/email digest)
  → M4 workflow parks on a Temporal signal
  → approver opens packet, opens evidence (dwell recorded), approves in 8.4s
  → decision recorded → override corpus
  → approval receipt to M7 with packet_digest
  → Temporal signal → run resumes → action enters hold (M6)
```

### 8.2 Expiry

```
no decision by expires_at
  → fallback applied (AUTO_REJECT default)
  → request state = expired; decision recorded as an expiry, not an approval
  → run resumes with a rejection; M4 replans or ends
  → audit entry records the expiry and the fallback that applied
```

### 8.3 Approve with edits

```
approver edits the draft body → approve
  → edit_diff_json computed structurally (before/after per field)
  → action args updated; risk re-evaluated (M5) — edits can change the tier
  → if the tier increased → re-approval required (never silently proceed on an edited action)
  → decision + diff recorded → override corpus
```

Re-evaluating risk after an edit closes an obvious hole: an approver pasting an external recipient
into an approved draft must not inherit the original approval.

---

## 9. Technology

| Concern | Choice | License |
|---|---|---|
| Packet rendering | Next.js server components + deterministic serializer | MIT |
| Hashing | `@noble/hashes` (shared with M7) | MIT |
| Queue interactions | TanStack Table + custom keyboard layer | MIT |
| Mobile | React Native + Expo | MIT |
| Push | ntfy (self-host) or FCM | Apache-2.0 / proprietary |
| Email digests | Provider-agnostic sender; MJML templates | MIT |
| Realtime | SSE | — |
| Scheduling (batches) | Temporal schedules | MIT |

**Deterministic serialization matters:** the same packet must hash identically across renders, or
the M7 receipt is meaningless. Reuse M7's canonical JSON implementation.

---

## 10. Security

| Control | Implementation |
|---|---|
| Authorization at decide time | Role re-checked when deciding, not when assigning |
| Separation of duties | Requester ≠ approver; dual approvers distinct. Service-enforced |
| Packet integrity | Server-rendered, hashed, digest in the audit receipt |
| Mobile approve | Biometric required; revoke deliberately unauthenticated |
| Notification content | Never include sensitive content in a push payload — title and deep link only |
| Delegation abuse | Time-bounded, audited, cannot delegate a role you do not hold |
| Edit escalation | Edits re-trigger risk evaluation; tier increase forces re-approval |
| Expired-request replay | Decisions on expired or superseded requests are rejected |

---

## 11. Testing

| Suite | Tool | Gate |
|---|---|---|
| Packet determinism | Unit — identical hash across renders | **Blocking** |
| Expiry + fallback | Time-travel integration | **Blocking** |
| Separation of duties | Integration — requester cannot approve | **Blocking** |
| Decide-time authorization | Integration — role revoked after assignment | **Blocking** |
| Edit → re-evaluation | Integration — tier increase forces re-approval | **Blocking** |
| Telemetry completeness | Integration — every decision writes a full corpus row | **Blocking** |
| Notification budget | Integration | Blocking |
| Approval latency | Usability testing with real approvers | Median < 10s |
| Mobile revoke | E2E from push | < 5s end-to-end (with M6) |
| Rubber-stamp detection | Synthetic approver behavior | Blocking |
| Accessibility | axe + keyboard-only walkthrough | **Blocking** |

### 11.1 Usability testing is a gate, not a nicety

The 10-second median is an acceptance criterion. Test it with **the design partner's actual
approvers**, not with engineers. If they cannot decide in 10 seconds, the packet is wrong — iterate
the packet, do not relax the target.

---

## 12. Acceptance Criteria

- [ ] Median approval latency < 10s; p90 < 45s for routine tiers
- [ ] **Evidence-open rate > 60%** on HIGH/CRITICAL items
- [ ] Zero approval requests without an expiry and a declared fallback
- [ ] Notification volume within budget for 100% of active tenants
- [ ] Packets render server-side and hash deterministically; digest lands in the M7 receipt
- [ ] Separation of duties enforced for dual approval
- [ ] Authorization re-checked at decide time
- [ ] Edits re-trigger risk evaluation; a tier increase forces re-approval
- [ ] Mobile: approve requires biometric; revoke requires nothing and completes in < 5s
- [ ] 100% of decisions write a complete override-corpus row including structural edit diffs
- [ ] Rubber-stamp flags computed nightly and visible to the compliance officer
- [ ] Action Center complete: brief, tasks, security, usage, autonomy shell, verification status
- [ ] Keyboard-only operation of the full queue; axe passes

---

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Approval fatigue** | Pilot dies in month two | Batching, budgets, packet discipline; treat notification overflow as a bug |
| Packets too dense | Approvers skim | Usability-test with real approvers; evidence one tap away, not on screen |
| Bulk approval becomes rubber-stamping | False oversight evidence | Homogeneous-only bulk; monitoring flags; never allow heterogeneous bulk |
| Approvers game the metrics | Monitoring becomes adversarial | Frame flags as product signals, not performance management |
| Mobile approve too frictionless | Careless approvals | Biometric on approve; asymmetry is intentional |
| Telemetry gaps | M10's moat degrades silently | Completeness is a blocking test; alert on any decision without a corpus row |

> **The corpus is the moat. A dropped telemetry row is lost forever.** Treat write failures here
> with the same seriousness as a dropped audit entry.

---

## 14. Deliverables

- [ ] `services/control/approvals` — orchestrator, routing, delegation, batching, expiry
- [ ] Server-side packet renderer with deterministic hashing
- [ ] Approval inbox with keyboard navigation and homogeneous bulk actions
- [ ] Mobile app (Expo): approve / reject / revoke with asymmetric auth
- [ ] Push and email digest delivery with budget enforcement
- [ ] Override corpus capture including structural edit diffs
- [ ] Rubber-stamp detection job and compliance view
- [ ] Full Action Center: brief, tasks, security, usage, autonomy shell, verification status
- [ ] Migrations for all §4 tables
- [ ] `approvalGate` default in M4 replaced; its warning removed
- [ ] Usability test report with the design partner's approvers

---

## 14.1 Single-user mode (self-serve tiers, PROJECT.md §22.1)

On Free, Pro, and Business there is no role routing, no delegation, and no dual approval — the
account owner is the only approver. The packet, the telemetry, and the audit receipt are
**identical**; only the routing layer collapses.

| Element | Self-serve | Teams / Enterprise |
|---|---|---|
| Decision packet | Identical, server-rendered, hashed | Identical |
| Routing | Always the account owner | Role to user, delegation, escalation chain |
| Dual approval / separation of duties | n/a | Enforced |
| Batching | Simple: immediate or daily digest | Configurable review moments |
| Override telemetry | **Captured identically** | Captured identically |
| Rubber-stamp monitoring | Surfaced to the user as a nudge | Surfaced to Compliance |

**Capture the override corpus on every tier.** A solo user editing a draft before sending is the
same signal as an enterprise approver doing it, and cheap tiers generate far more volume per
dollar. The corpus is the moat (PROJECT.md §1.5) — the self-serve tier should make it *larger*,
not absent.

---

## 15. Notes for the Next Module

Modules 9 and 10 both consume this module's output. M9's verification failures should route through
the same packet renderer so a human sees one consistent surface. M10 reads `approval_decisions`
directly — ensure `edit_diff_json` is structurally typed per tool (not stringified), because the
learned-policy proposals depend on grouping edits by field, not by rendered text.
