# Module 6 — Reversibility Layer

> **D1. The keystone.** Nobody sells undo for real-world actions. The engineering pattern exists as
> developer plumbing; nobody has made it a governed, business-user-facing capability. This module
> is the single largest reason a customer chooses VEGA.

| | |
|---|---|
| **Phase** | 1 (months 5–7) |
| **Covers** | D1 (PROJECT.md §8.1), §12.2 saga semantics |
| **Depends on** | M2 (`simulate()`, reversibility classes), M4 (executor hooks), M5 (hold windows) |
| **Blocks** | M8 (revoke UX), M10 (reversibility raises the autonomy ceiling) |
| **Estimate** | 8–10 engineer-weeks, plus ongoing per-connector cost |

---

## 1. Purpose & Scope

### 1.1 The strategic point

Reversibility is an input to risk (M5 factor 4). Therefore **making an action reversible lowers its
risk tier and unlocks autonomy.** The safety system is the thing that increases automation:

```
   more reversibility  ──>  lower risk score  ──>  higher autonomy tier
           ▲                                              │
           │                                              ▼
   better compensators  <──  more override data  <──  more actions executed
```

Every engineering hour spent on a compensator directly increases the share of a customer's work
that can run unattended. Competitors have no equivalent flywheel — a blocked action generates no
learning and no additional value.

### 1.2 What this module delivers

1. **Compensators** — a registered, tested inverse for every `R1` action.
2. **Hold windows** — a revocable delay before `R2` actions are released.
3. **Blast-radius simulation** — the *effect* preview, not the plan.
4. **Time-to-Undo** — a published, measured metric.
5. **Saga execution** — reverse-order compensation with incident handling on failure.

### 1.3 In scope

- Compensator interface, registry, capture/execute lifecycle, TTL handling
- Per-connector compensator implementations for the launch set
- Hold buffer: timers, release, revoke, edit-and-requeue
- Blast-radius aggregation across a whole run
- Divergence detection (simulated vs. actual)
- Compensation failure as a first-class incident
- Time-to-Undo instrumentation
- Frontend: blast radius panel, hold countdown, revoke controls, compensation status

### 1.4 Out of scope

Approval decisions (M5 decides, M8 renders) · notification delivery (M8) · autonomy demotion on
compensation failure (M10 acts on the event this module emits) · audit receipts (M7).

---

## 2. Dependencies

| From | Needs |
|---|---|
| M2 | `reversibility`, `compensatorRef`, `holdSupported`, `simulate()`, idempotency keys |
| M4 | `captureCompensator` and `simulateHook` extension points; Temporal saga scaffolding |
| M5 | `ALLOW_WITH_HOLD` + `hold_window_ms`; risk tier feeding default windows |

---

## 3. Architecture

```
   plan (M4)                              execution (M4)
      │                                        │
      ▼                                        ▼
┌───────────────────┐              ┌──────────────────────────┐
│ Blast Radius      │              │ Compensator Registry     │
│ aggregate all     │              │ capture() BEFORE call    │
│ simulate() effects│              └────────────┬─────────────┘
└─────────┬─────────┘                           │ token
          │ shown to user/policy                ▼
          ▼                          ┌──────────────────────┐
   proceed?                          │ Tool executes (M2)   │
                                     └──────────┬───────────┘
                                                │
                         R0/R1 ─────────────────┼──────── R2
                          committed             │          │
                                                │          ▼
                                                │   ┌──────────────┐
                                                │   │ Hold Buffer  │
                                                │   │ timer + revoke│
                                                │   └──────┬───────┘
                                                │     release│revoke
                                                ▼           ▼
                                          verify (M9) ── fail ──▶ COMPENSATE
                                                                  (reverse order)
```

---

## 4. Data Model

```sql
-- ============ Compensations ============
CREATE TABLE compensations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  action_id     uuid NOT NULL REFERENCES actions(id),
  run_id        uuid NOT NULL,
  tool_id       text NOT NULL,
  compensator_ref text NOT NULL,
  token_json    jsonb NOT NULL,       -- captured pre-state; everything needed to reverse
  token_digest  text NOT NULL,
  confidence    text NOT NULL,        -- EXACT | APPROXIMATE
  side_effects  text NOT NULL,        -- SILENT | NOTIFIES_THIRD_PARTY
  ttl_at        timestamptz NOT NULL, -- after this, the action is permanent
  state         text NOT NULL DEFAULT 'armed',
                -- armed|executing|succeeded|failed|expired|not_needed
  attempts      int NOT NULL DEFAULT 0,
  executed_at   timestamptz,
  result_json   jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON compensations (run_id, created_at);
CREATE INDEX ON compensations (state, ttl_at) WHERE state = 'armed';

-- ============ Holds ============
CREATE TABLE holds (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  action_id     uuid NOT NULL REFERENCES actions(id),
  run_id        uuid NOT NULL,
  window_ms     int  NOT NULL,
  artifact_ref  text NOT NULL,        -- the held content, viewable during the hold
  expires_at    timestamptz NOT NULL,
  released_at   timestamptz,
  released_by   text,                 -- 'timer' | user_id
  revoked_at    timestamptz,
  revoked_by    uuid REFERENCES users(id),
  revoke_reason text,
  edited        boolean NOT NULL DEFAULT false,
  edit_diff     jsonb,                -- feeds M10's override corpus
  state         text NOT NULL DEFAULT 'holding',
                -- holding|released|revoked|edited_requeued|expired_released
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON holds (state, expires_at) WHERE state = 'holding';

-- ============ Blast radius snapshots ============
CREATE TABLE blast_radius (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  run_id        uuid NOT NULL,
  program_id    uuid NOT NULL,
  effects_json  jsonb NOT NULL,       -- aggregated per-tool effects
  summary_json  jsonb NOT NULL,       -- counts by category for the UI
  min_fidelity  text NOT NULL,        -- weakest fidelity across the run
  computed_at   timestamptz NOT NULL DEFAULT now()
);

-- ============ Divergence (simulated vs actual) ============
CREATE TABLE divergences (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  action_id     uuid NOT NULL,
  simulated_json jsonb NOT NULL,
  actual_json   jsonb NOT NULL,
  diff_json     jsonb NOT NULL,
  severity      text NOT NULL,        -- WITHIN_TOLERANCE | ABORT
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ============ Time-to-Undo measurements ============
CREATE TABLE undo_metrics (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  action_id     uuid NOT NULL,
  tool_id       text NOT NULL,
  kind          text NOT NULL,        -- revoke | compensate
  requested_at  timestamptz NOT NULL, -- user decided
  restored_at   timestamptz,          -- state restored
  duration_ms   int,
  succeeded     boolean NOT NULL
);
```

---

## 5. Backend

### 5.1 Reversibility classes

| Class | Meaning | Mechanism | Examples |
|---|---|---|---|
| **R0** | Fully reversible | Native undo / version restore | Draft edit, label change, file version write |
| **R1** | Compensable | Registered inverse restores equivalent state | Calendar event → delete + notify; CRM write → snapshot restore |
| **R2** | Hold-only | Cannot reverse after release; release can be delayed | Outbound email, Slack message, published post |
| **R3** | Irreversible | No undo, no meaningful delay | Payment capture, regulatory filing, destructive third-party call |

> **Design rule:** the engineering goal for every connector action is to move it *up* this ladder.
> Turning an R3 into an R2, or an R2 into an R1, is directly worth money because it raises the
> autonomy ceiling for that action. Track ladder movement as a roadmap metric.

### 5.2 Compensator interface

```ts
export interface Compensator<T = unknown> {
  ref: string;                        // matches ToolDeclaration.compensatorRef
  toolId: string;

  /** Captured BEFORE the forward action. Must contain everything needed to reverse
   *  without re-deriving it — the world will have changed by compensation time. */
  capture(args: ToolArgs, ctx: ActionContext): Promise<CompensationToken<T>>;

  /** Executed in reverse order on rollback. Must be idempotent. */
  compensate(token: CompensationToken<T>, ctx: ActionContext): Promise<CompensationResult>;

  confidence: 'EXACT' | 'APPROXIMATE';
  sideEffects: 'SILENT' | 'NOTIFIES_THIRD_PARTY';
  ttl: Duration;
}
```

### 5.3 Honest constraints — designed for, never hidden

**A compensator is not a perfect inverse.** You can reverse a refund; you cannot un-send an email.
`confidence: 'APPROXIMATE'` must be surfaced in the UI:

> "We will delete the meeting and notify the three attendees" — not "it never happened."

`sideEffects: 'NOTIFIES_THIRD_PARTY'` triggers a confirmation before compensating: the user must
know that undoing is itself visible to someone outside the organization.

**Compensation can fail.** A failed compensation is a **first-class incident**: it pages, appears
in the Security Center (M8), writes a signed audit entry (M7), and auto-demotes the workflow's
autonomy tier (M10). It is never a silent log line.

**Compensators expire.** After `ttl_at`, the action is permanent and the UI says so. TTLs are
per-tool and reflect provider reality (a calendar event can be deleted next week; a Slack message
edit window may be shorter).

### 5.4 Launch compensator set

| Tool | Compensator | Confidence | Side effects | TTL |
|---|---|---|---|---|
| `gmail.draft` | Delete draft by id | EXACT | SILENT | 30d |
| `gmail.label` | Remove label / restore prior labels | EXACT | SILENT | 30d |
| `gcal.create` | Delete event + cancellation notice | APPROXIMATE | **NOTIFIES_THIRD_PARTY** | 90d |
| `gcal.update` | Restore captured snapshot | APPROXIMATE | NOTIFIES_THIRD_PARTY | 90d |
| `gcal.delete` | Recreate from snapshot + re-invite | APPROXIMATE | NOTIFIES_THIRD_PARTY | 30d |
| `gdrive.write` | Restore prior revision id | EXACT | SILENT | 30d |
| `gdrive.share` | Revoke the permission grant | EXACT | SILENT (grantee may have seen it) | 90d |
| `slack.post` | Delete message | APPROXIMATE | NOTIFIES_THIRD_PARTY | 7d |
| `gmail.send` | — (R2, hold only) | — | — | — |
| `http.request` | — (R3) | — | — | — |

**Capture discipline:** `gcal.update`'s capture must store the *complete* prior event — attendees,
recurrence, conference data, reminders — not just changed fields. A partial snapshot produces a
compensation that silently loses data, which is worse than no compensation.

### 5.5 Hold buffer

Applies to `R2` actions when policy returns `ALLOW_WITH_HOLD`.

**Default windows** (policy overrides; policy wins where both apply):

| Risk tier | Default window |
|---|---|
| LOW | 30s |
| MEDIUM | 2min |
| HIGH | 10min |
| Client comms (vertical policy) | 15min |

**Implementation:** Temporal timer inside a cancellation scope. The action is committed *internally*
(audit entry written, state `HELD`) but not released to the provider. On timer expiry the release
activity runs. On revoke signal the scope cancels and the action moves to `REVOKED`.

**Available operations during a hold:**

| Operation | Effect |
|---|---|
| **Revoke** | Cancel; action never reaches the provider. **No login challenge required** |
| **Release now** | Skip the remaining window |
| **Edit and requeue** | Modify content, restart the window, record `edit_diff` (M10 corpus) |
| **View** | See exactly what will be sent |

**Asymmetry by design:** revoke is the fast, frictionless path; release-early requires
authentication. The safe action must always be the cheapest to take.

**Restart safety:** holds survive process restarts via Temporal. On worker recovery, a hold whose
expiry has already passed is released only if the audit entry confirms it was never revoked —
otherwise it fails to `NEEDS_ATTENTION` rather than guessing.

### 5.6 Blast-radius aggregation

Runs `simulate()` (M2) across every planned tool call and aggregates:

```
This run will:
  ✉  send 3 emails       → 2 external domains (acme.com, contoso.com)   [R2 · 10m hold]
  📅 create 1 event      → 4 attendees, Thu 14:00                        [R1 · reversible]
  🗂  update 1 CRM field  → Acme / Stage: Negotiation → Closed Won        [R1 · reversible]
  💸 no financial actions
  🔒 reads: 12 emails, 3 documents  (2 contain PII)

  Simulation fidelity: DERIVED for 2 of 5 actions
```

**Fidelity is reported honestly.** `min_fidelity` across the run is shown, because a blast radius
is only as trustworthy as its weakest simulation. Runs whose minimum fidelity is `DECLARED` cannot
be promoted past `SUPERVISED` in M10.

### 5.7 Divergence detection

After execution, diff the actual effect against the simulated effect.

| Outcome | Handling |
|---|---|
| Within per-tool tolerance | Record, continue |
| Beyond tolerance | **Abort the run**, log a verification failure, compensate committed steps |

Tolerances are declared per tool (e.g. an event id will differ; a recipient list must not).
Divergence rate per tool is tracked — a rising rate means the simulation has drifted from provider
behavior and the tool needs attention.

### 5.8 Saga execution

Per PROJECT.md §12.2:

- Forward actions execute in graph order; each registers its compensator **before** committing.
- On unrecoverable failure, compensators run in **strict reverse order** of commitment.
- Compensation is itself audited and can itself fail → `COMPENSATION_FAILED` incident.
- `R3` actions are at-most-once and are ordered **last** in the graph wherever the plan permits,
  so that as much as possible remains reversible when they execute. The planner (M4) applies this
  ordering preference; this module enforces it as a validation rule.
- Compensations retry with backoff up to a bound, then escalate. They never retry forever.

### 5.9 Time-to-Undo instrumentation

Measured from **"user decides to undo"** (the click, or the automatic failure detection) to
**"state restored"** (provider confirms). Not from when our backend started working — the user's
experience is what is published.

Reported per action type as median and p99, in-product and in sales material.

---

## 6. Frontend

### 6.1 Blast radius panel

Rendered before execution for any run containing a consequential action, and inside every approval
packet (M8). Grouped by effect category, with reversibility badges and the fidelity note. Expandable
per action to show the exact before/after.

### 6.2 Hold countdown

```
┌──────────────────────────────────────────────────────┐
│  ⏱  Sending in 9:42                                   │
│                                                       │
│  To:      peter@acme.com                              │
│  Subject: Re: Partnership terms                       │
│  [ View full message ]                                │
│                                                       │
│  [ Revoke ]  [ Edit ]  [ Send now ]                   │
└──────────────────────────────────────────────────────┘
```

Present in chat, the Action Center (M8), and as a push notification. The countdown is live; revoke
is a single tap with no confirmation dialog — confirming a revoke defeats its purpose.

### 6.3 Undo control on committed actions

For `R1` actions inside their TTL, an explicit **Undo** control with an honest description:

```
Undo "Meeting with Acme, Thu 14:00"?

  This will delete the event and send a cancellation
  notice to 4 attendees. They will see that it was
  cancelled.

  Available for another 89 days.

  [ Cancel ]  [ Undo the meeting ]
```

`NOTIFIES_THIRD_PARTY` compensators always show the consequence before proceeding.

### 6.4 Compensation status

Live progress during a rollback (which steps are being reversed, in what order, current state) and
a clear terminal state. On `COMPENSATION_FAILED`: what failed, what state the world is in now, and
the manual remediation steps — this screen is read by someone under stress; write it plainly.

### 6.5 Time-to-Undo dashboard

Per action type: median, p99, success rate, trend. Lives in the Action Center (M8) and is quoted
in sales.

---

## 7. APIs

```
GET    /v1/runs/:id/blast-radius          # simulated effects, pre-execution
POST   /v1/runs/:id/blast-radius/refresh  # re-simulate after a plan change

GET    /v1/holds                          # active holds for the caller/tenant
GET    /v1/holds/:id
POST   /v1/actions/:id/revoke             # revoke a held action  (fast path, no re-auth)
POST   /v1/actions/:id/release            # release early         (requires auth)
POST   /v1/actions/:id/edit-requeue       # modify + restart the window

POST   /v1/actions/:id/compensate         # explicit undo of a committed R1
GET    /v1/actions/:id/compensation       # status + confidence + side effects + TTL
GET    /v1/runs/:id/compensations

GET    /v1/metrics/time-to-undo           # by tool, period
GET    /v1/divergences                    # simulated vs actual, for tool health

Webhooks: action.held · action.released · action.revoked ·
          compensation.started · compensation.succeeded ·
          compensation.failed  ← incident · divergence.detected
```

---

## 8. Key Flows

### 8.1 Hold, revoke

```
policy → ALLOW_WITH_HOLD (10min)
  → audit entry written (M7)
  → action state = HELD; artifact stored; Temporal timer started
  → user notified (push + Action Center)
  → user taps Revoke at t+42s
     → cancellation scope cancelled
     → action state = REVOKED; nothing reached the provider
     → undo_metrics: kind=revoke, duration = 1.2s
     → override telemetry to M10 (revoked + reason)
```

### 8.2 Compensating a failed run

```
step 4 of 6 fails unrecoverably
  → saga triggers
  → reverse order: compensate step 3 (gcal.create → delete + notify)
                   compensate step 2 (gdrive.write → restore revision)
                   step 1 was R0 read → not_needed
  → each compensation audited
  → run state = COMPENSATED
  → user shown what was reversed and what notifications went out
```

### 8.3 Compensation failure

```
compensate(gcal.create) → provider returns 403 (organizer changed)
  → retry with backoff ×3 → still failing
  → compensations.state = failed
  → INCIDENT: page on-call, Security Center entry, signed audit entry
  → M10: auto-demote this workflow's autonomy tier
  → UI shows exact residual state + manual remediation steps
```

---

## 9. Technology

| Concern | Choice | License |
|---|---|---|
| Saga orchestration | Temporal (from M4) | MIT |
| Hold timers | Temporal timers + cancellation scopes | MIT |
| Fast revoke path | Valkey-backed lookup for sub-second response | BSD-3 |
| Token storage | Postgres `jsonb`; large snapshots → object storage by reference | — |
| Diffing | `deep-object-diff` / custom per effect shape | MIT |
| Push | ntfy (self-host) or FCM | Apache-2.0 / proprietary |

**Why the revoke path is separate:** revoking must be sub-second even under load. The revoke
endpoint checks a Valkey key and signals Temporal, rather than doing a full policy/authz round
trip. Authorization is still enforced — but the check is precomputed when the hold is created.

---

## 10. Security

| Control | Implementation |
|---|---|
| Revoke authorization | Precomputed at hold creation: the principal, the workflow owner, and workspace admins may revoke. No re-auth for revoke |
| Release authorization | Requires an authenticated session — asymmetric with revoke, deliberately |
| Compensation authorization | Same as revoke, plus `NOTIFIES_THIRD_PARTY` requires explicit confirmation |
| Token confidentiality | Compensation tokens may contain content snapshots — encrypted at rest, sensitivity-gated on read |
| Replay protection | Compensation is idempotent; double-compensate is a no-op, not a double-notify |
| Hold artifact access | Scoped to those who can revoke |

---

## 11. Testing

| Suite | Tool | Gate |
|---|---|---|
| **Compensator correctness** | Custom, against sandbox providers | **Blocking — a connector cannot register without it** |
| Compensation idempotency | Integration — compensate twice, one effect | **Blocking** |
| Reverse ordering | Integration — assert strict reverse commitment order | **Blocking** |
| Hold timer accuracy | Integration ±1s | Blocking |
| Revoke latency | Load test | p99 < 5s end-to-end from tap |
| Restart during hold | Chaos — kill worker mid-hold | **Blocking** |
| Compensation failure path | Fault injection — assert incident + demotion event | **Blocking** |
| Divergence detection | Integration with deliberately drifted simulate | Blocking |
| TTL expiry | Time-travel test | Blocking |
| Blast radius accuracy | Reuses M2's harness | Nightly |

### 11.1 Compensator correctness harness

Extends M2's simulation harness. Per compensator:

1. Capture initial provider state.
2. Execute the forward action; capture the compensation token.
3. Assert the effect occurred.
4. Execute compensation.
5. **Assert state equivalence with the initial capture**, modulo declared-approximate fields
   (event ids, timestamps, notification side effects).
6. Compensate again; assert no additional effect.

Runs against real sandbox tenants, not mocks. Mocked compensator tests give false confidence about
exactly the semantics that matter.

---

## 12. Acceptance Criteria

- [ ] 100% of registered `R1`/`R2` actions have a tested compensator (build-enforced from M2)
- [ ] Compensation success rate ≥ 99% in the harness
- [ ] Every compensation failure produces an incident, an audit entry, and a demotion event
- [ ] Compensation is idempotent — double execution produces one effect
- [ ] Compensations run in strict reverse order of commitment
- [ ] Hold revocation works end to end from mobile push in **< 5 seconds**
- [ ] Revoke requires no login challenge; release-early does
- [ ] Holds survive worker restarts; ambiguous cases fail to `NEEDS_ATTENTION`, never auto-release
- [ ] Simulation matches actual effect on ≥ 99% of eval runs; divergence beyond tolerance aborts
- [ ] Blast radius reports minimum fidelity honestly
- [ ] `APPROXIMATE` and `NOTIFIES_THIRD_PARTY` are surfaced in the UI before the user commits
- [ ] Time-to-Undo measured and dashboarded per action type

---

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **Per-connector compensator cost** | **Existential — PROJECT.md §24 kill criterion** | Measure precisely on connector #1. If a typical connector exceeds ~6 engineer-weeks to make compensable, the moat is unaffordable and the thesis needs revisiting |
| Providers lack true inverse operations | Compensators are approximate | Declare honestly; use hold windows where compensation is weak; move actions up the ladder where possible |
| Compensation snapshots grow large | Storage cost, slow capture | Reference object storage for large snapshots; TTL-based cleanup |
| Users trust "undo" more than it deserves | Reputational damage on an approximate undo | `APPROXIMATE` language is mandatory in the UI; never say "as if it never happened" |
| Hold windows annoy users | Feature gets disabled | Tier-scaled defaults; per-workflow tuning; the 30s low-risk default is nearly invisible |
| Compensation failures cascade | Unrecoverable state | Reverse-order sagas, bounded retries, clear manual remediation, incident path |

> **This module produces the data that decides whether the company works.** Instrument the
> engineering effort per connector as carefully as the runtime metrics.

---

## 14. Deliverables

- [ ] `packages/compensators` — interface, registry, capture/execute lifecycle, TTL handling
- [ ] Compensator implementations for all launch `R1`/`R2` tools (§5.4)
- [ ] Hold buffer with Temporal timers, revoke/release/edit-requeue
- [ ] Fast revoke path (Valkey precomputed authorization)
- [ ] Blast-radius aggregation and divergence detection
- [ ] Saga integration in the M4 executor; `captureCompensator` default replaced
- [ ] Migrations for all §4 tables
- [ ] Blast radius panel, hold countdown, undo control, compensation status, TTU dashboard
- [ ] `evals/compensation` harness against sandbox providers
- [ ] Per-connector compensator effort recorded in PROJECT.md §25 (kill-criterion data)

---

## 15. Notes for the Next Module

Module 7 must write the audit entry **before** any side effect, including before the hold commits.
Ensure the hold's internal commit already emits a `pre` receipt through M4's `receiptHook`, so M7
only replaces the implementation rather than moving the call site. Also: `edit_diff` from
edit-and-requeue is override telemetry — make sure it is captured in a shape M10 can consume.
