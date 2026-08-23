# Module 4 — Agent Core: Intent, Planning & Durable Execution

> C1, C2, C5. The loop that turns "handle the Acme meeting" into a validated program, executes it
> durably, and survives restarts, failures, and mid-run policy changes. This is the module that
> makes VEGA an agent rather than infrastructure.

| | |
|---|---|
| **Phase** | 1 (months 4–6) |
| **Covers** | C1 (Intent), C2 (Planner), C5 (Executor), PROJECT.md §7.1–7.2, §7.5, §10.3, §12 |
| **Depends on** | M1 (identity, tenancy), M2 (tools), M3 (DSL, interpreter, gate) |
| **Blocks** | M5 (policy hooks into execution), M6 (sagas), M7 (receipts), M8 (approval pauses) |
| **Estimate** | 7–9 engineer-weeks |

---

## 1. Purpose & Scope

### 1.1 What this module delivers

A user types an objective; VEGA resolves it into a structured goal, produces a validated DSL
program, executes it durably through the M3 interpreter, streams progress, and reports what
happened. Runs survive process restarts. Failures replan. Nothing executes that the interpreter
did not gate.

### 1.2 The shape of the loop

```
Understand (C1) → Plan (C2) → [Decide — M5] → [Simulate — M6]
   → Execute (C5) → [Verify — M9] → [Hold/Undo — M6] → [Learn — M10] → [Explain — M7]
```

This module owns Understand, Plan, and Execute, and defines the **extension points** the bracketed
modules plug into. Getting those seams right matters more than the planning quality — a planner
can be improved by prompting; a missing seam requires rewriting the executor.

### 1.3 In scope

- C1: intent extraction, entity resolution, ambiguity detection, clarification
- C2: objective → DSL program, replanning, plan versioning and diffing
- C5: durable orchestration (Temporal), run lifecycle, checkpointing, resumption
- Extension points: policy hook, simulation hook, approval pause/resume, compensation hook
- Streaming run progress to the UI
- Chat surface (real, not stubbed) with action cards
- Agent Studio v1: define an agent's objective, tools, triggers
- Run history and inspection

### 1.4 Out of scope

Risk scoring and policy decisions (M5 — the hook is here, the logic is there) · compensators and
holds (M6) · audit receipts (M7) · approval UX (M8) · verification (M9) · memory (M9) ·
autonomy tiers (M10).

**Seam-only rule:** where a later module owns the logic, this module ships a typed interface plus a
permissive default that logs loudly. Never an implicit `true`.

---

## 2. Dependencies

| From | Needs |
|---|---|
| M1 | Tenant context, agent machine identities, per-run tokens |
| M2 | Tool declarations, connector runtime, `simulate()` |
| M3 | DSL grammar, validator, interpreter, gate, planner prompt contract, program-validity harness |

---

## 3. Architecture

```
   chat / trigger
        │
        ▼
┌───────────────────┐
│ C1 Intent Service │  resolve entities · detect ambiguity · reject untrusted origin
└─────────┬─────────┘
          │ Objective
          ▼
┌───────────────────┐   metadata-only prompt (M3 §7.5)
│ C2 Planner        │──────────────────────────────▶ Claude Opus 5
│                   │◀── DSL program ──────────────
└─────────┬─────────┘
          │ program → static validation (M3)
          ▼
┌─────────────────────────────────────────────────────────┐
│ C5 Executor — Temporal workflow = one run               │
│                                                         │
│  per step:  policyHook(M5) → simulateHook(M6)           │
│             → approvalGate(M8) → interpreter(M3)        │
│             → connector(M2) → verifyHook(M9)            │
│             → receiptHook(M7) → compensatorHook(M6)     │
└─────────────────────────────────────────────────────────┘
```

**One Temporal workflow per run. One activity per tool call.** That mapping makes M6's saga
semantics nearly free and is the reason Temporal was chosen (TECHSTACK §8).

---

## 4. Data Model

```sql
-- ============ Runs ============
CREATE TABLE runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id),
  workspace_id      uuid NOT NULL REFERENCES workspaces(id),
  agent_id          uuid NOT NULL REFERENCES agents(id),
  principal_user_id uuid NOT NULL REFERENCES users(id),   -- on whose behalf
  trigger           text NOT NULL,          -- chat|schedule|webhook|api
  objective_json    jsonb NOT NULL,         -- C1 output
  program_id        uuid,                   -- REFERENCES programs(id) from M3
  status            text NOT NULL,          -- see §5.4 state machine
  temporal_run_id   text,
  checkpoint_json   jsonb,
  error_json        jsonb,
  cost_cents        int NOT NULL DEFAULT 0,
  started_at        timestamptz NOT NULL DEFAULT now(),
  ended_at          timestamptz
);
CREATE INDEX ON runs (tenant_id, status, started_at DESC);
CREATE INDEX ON runs (agent_id, started_at DESC);

-- ============ Task nodes (the executable graph) ============
CREATE TABLE task_nodes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES runs(id),
  parent_id             uuid REFERENCES task_nodes(id),
  step_index            int  NOT NULL,
  kind                  text NOT NULL,   -- TOOL_CALL|REASONING|HUMAN_INPUT|CHECKPOINT|VERIFY|COMPENSATE
  tool_id               text,
  args_json             jsonb,
  -- pre-annotated at PLAN time, before anything executes (PROJECT.md §7.2)
  planned_risk          int,
  planned_reversibility text,
  planned_egress        text,
  status                text NOT NULL,   -- pending|gated|approving|running|held|done|failed|skipped|compensated
  attempt               int NOT NULL DEFAULT 0,
  result_ref            text,            -- content-addressed
  effect_json           jsonb,
  started_at            timestamptz,
  ended_at              timestamptz,
  UNIQUE (run_id, step_index)
);

-- ============ Actions (the consequential subset — M6/M7 extend this) ============
CREATE TABLE actions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id         uuid NOT NULL REFERENCES runs(id),
  node_id        uuid NOT NULL REFERENCES task_nodes(id),
  tool_id        text NOT NULL,
  args_digest    text NOT NULL,
  effect_json    jsonb,
  taint_level    text NOT NULL,
  reversibility  text NOT NULL,
  risk_score     int,                    -- filled by M5
  risk_tier      text,                   -- filled by M5
  state          text NOT NULL,          -- PLANNED|HELD|COMMITTED|COMPENSATED|FAILED|REVOKED
  committed_at   timestamptz,
  released_at    timestamptz
);

-- ============ Replanning history ============
CREATE TABLE replans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid NOT NULL REFERENCES runs(id),
  from_step   int  NOT NULL,
  reason      text NOT NULL,   -- tool_failure|verify_failure|policy_denial|lock_timeout|
                               -- precondition_invalid|human_modification|invalid_program
  detail_json jsonb,
  new_program_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============ Agent specs (M1 created the row; M4 fills spec_json) ============
-- spec_json shape:
-- {
--   "objective_template": "...",
--   "allowed_connectors": ["gmail","gcal"],
--   "allowed_tools": ["gmail.search","gmail.read","gmail.draft","gcal.create"],
--   "triggers": [{ "kind":"schedule", "cron":"0 8 * * 1-5", "tz":"Europe/London" }],
--   "policy_bindings": ["external-comms-supervision"],
--   "escalation": { "approver_role": "APPROVER", "expiry": "4h", "fallback": "AUTO_REJECT" },
--   "limits": { "max_steps": 50, "max_cost_cents": 200, "max_fanout": 20 }
-- }
```

---

## 5. Backend

### 5.1 C1 — Intent & Goal Understanding

**Output contract** (PROJECT.md §7.1):

```jsonc
{
  "objective": "Schedule a follow-up with Acme and send the revised proposal",
  "entities": [
    { "type": "org", "raw": "Acme", "resolved_id": "crm:acct_8812",
      "confidence": 0.94, "taint": "TRUSTED" }
  ],
  "constraints": ["afternoons only", "before Friday"],
  "success_criteria": ["meeting exists on calendar", "proposal sent to primary contact"],
  "ambiguities": [
    { "field": "which proposal", "candidates": ["v2","v3"], "blocking": true }
  ],
  "requested_autonomy": "supervised"
}
```

**Behavioral rules:**

1. **Origin check first.** An objective may originate *only* from an authenticated principal.
   Content arriving from an email body can never become an objective (M3 §5.3 corollary 2). A run
   triggered by inbound email carries the *email* as an untrusted source and the *trigger rule*
   as the trusted objective.
2. **Entity resolution before planning.** Resolve names against memory (M9) and connected systems.
   A resolved entity is `TRUSTED`; an unresolved string stays `UNTRUSTED`. This is the mechanism
   that keeps `@recipient` arguments satisfiable — and the reason over-tainting is fixed by better
   resolution, not weaker rules.
3. **Ambiguity policy is reversibility-dependent:**

   | Ambiguity affects | Behavior |
   |---|---|
   | `R0` action | Resolve by best guess; note the assumption in the trace |
   | `R1` action | Best guess; surface prominently in the blast radius |
   | `R2`/`R3` action | **Blocking clarification.** Never guess |

4. Emit `HUMAN_INPUT` nodes for blocking ambiguities rather than failing the run.

### 5.2 C2 — Task Planner

**Input:** the metadata-only prompt from M3 §7.5 — objective, source *metadata*, tool
declarations, available schemas, agent limits. Never raw untrusted content.

**Output:** a DSL program (M3 §6).

**Pipeline:**

```
build metadata prompt → Claude Opus 5 (structured output)
  → parse to AST
  → static validation (M3 §6.3)
     ├─ valid   → persist program, expand to task_nodes with pre-annotations
     └─ invalid → structured error → ONE bounded replan attempt → else abort
```

**Pre-annotation is the point.** Expanding the program into `task_nodes` writes
`planned_risk`, `planned_reversibility`, and `planned_egress` for every tool call *before
execution*. This is what lets M6 simulate a blast radius and M5 gate a plan as a whole rather than
step by step.

**Bounds enforced from the agent spec:** `max_steps`, `max_fanout`, `max_cost_cents`. A program
exceeding them is rejected at validation, not discovered at runtime (threat T7).

**Plan versioning:** every program is persisted with its digest and pinned model id. Replans create
a new program linked to the run; the UI can diff them. Required for M7 replay.

### 5.3 C5 — Durable Executor

**Temporal mapping:**

| VEGA concept | Temporal |
|---|---|
| Run | Workflow execution |
| Tool call | Activity |
| Hold window (M6) | Timer + cancellation scope |
| Approval wait (M8) | Signal + timeout |
| Compensation (M6) | Saga compensation stack |
| Checkpoint | Workflow state (automatic) |

**Per-step sequence (the seam order matters):**

```ts
for (const node of graph) {
  await policyHook(node);           // M5 — may DENY, HOLD, or REQUIRE_APPROVAL
  const sim = await simulateHook(node);   // M6 — blast radius
  await approvalGate(node, sim);    // M8 — pauses the workflow on a signal
  await receiptHook(node, 'pre');   // M7 — audit entry BEFORE the side effect
  await captureCompensator(node);   // M6 — BEFORE the call
  const result = await interpreterStep(node);   // M3 — gate + execute via M2
  await verifyHook(node, result);   // M9 — may trigger compensation
  await receiptHook(node, 'post');  // M7
}
```

Two orderings are load-bearing and must not be "optimized":

- **Receipt before side effect** (PROJECT.md invariant 2). An action that happened without an
  audit entry is unprovable.
- **Compensator capture before the call** (M6). Capturing afterward means the pre-state is gone.

**Activity configuration:**

| Property | Value |
|---|---|
| Retry | Only for `TRANSIENT` and `RATE_LIMITED` errors |
| **Never retry** | Any `R2`/`R3` past commit — at-most-once (PROJECT.md §12.2) |
| Timeouts | Per tool from the declaration; heartbeat for long calls |
| Idempotency key | `run_id + node_id`, passed to M2 |

### 5.4 Run state machine

```
   CREATED → PLANNING → PLANNED → EXECUTING ─┬─▶ COMPLETED
                │            │                │
                │            │                ├─▶ AWAITING_APPROVAL ──(signal)──▶ EXECUTING
                │            │                ├─▶ HELD ──(release/revoke)──▶ EXECUTING / REVOKED
                │            │                ├─▶ AWAITING_INPUT ──(signal)──▶ PLANNING
                ▼            ▼                │
             FAILED     PLAN_REJECTED         ├─▶ COMPENSATING ─▶ COMPENSATED
                                              │                 └▶ COMPENSATION_FAILED (incident)
                                              └─▶ CANCELLED
```

Every transition emits a platform event and (from M7) a signed audit entry.

### 5.5 Replanning

Triggers, per PROJECT.md §7.2: tool failure, verification failure, policy denial, contention lock
timeout, invalidated precondition, human modification of a pending action, invalid program.

**Rules:** replan from the last checkpoint, never from step 0. Committed side effects are facts —
the new plan accounts for them and never re-executes them. Replan attempts are bounded (default 3
per run); exceeding aborts with a clear reason. Every replan writes a `replans` row with its cause.

### 5.6 Extension point defaults

| Hook | Owner | M4 default |
|---|---|---|
| `policyHook` | M5 | `ALLOW` + `warn("policy engine not installed")` on every call |
| `simulateHook` | M6 | Calls M2 `simulate()` directly; no aggregation |
| `approvalGate` | M8 | No-op + warn |
| `receiptHook` | M7 | Writes `platform_events` + warn |
| `captureCompensator` | M6 | No-op + warn |
| `verifyHook` | M9 | No-op + warn |

The warnings are deliberate and loud: a deployment running with defaults is ungoverned, and the
logs must say so on every single step. Remove a warning only when its module lands.

---

## 6. Frontend

### 6.1 Chat surface (`/chat`) — real in this module

- Threaded conversations scoped to a workspace and agent.
- Streaming: intent → plan → per-step progress via SSE.
- **Action cards, not prose.** Any consequential step renders a card: effect summary, risk tier,
  reversibility badge, provenance chips (M3), and the control set (approve / modify / reject —
  wired properly in M8).
- Inline clarification prompts for blocking ambiguities.
- `@`-mention of connectors and knowledge sources to scope a request.

### 6.2 Run inspector (`/runs/:id`)

Timeline of nodes with status, duration, and effect; the program AST with the executed path
highlighted; plan diffs across replans; provenance graph (M3); cost and model usage; error detail
with the replan chain.

### 6.3 Agent Studio v1 (`/studio`)

Define objective template, allowed connectors and tools (from declarations), triggers (manual,
schedule, webhook), limits, and escalation defaults. Autonomy tier is displayed as `SHADOW` and is
**read-only until M10** — do not offer a control the system cannot yet honor.

### 6.4 Component inventory

| Component | Notes |
|---|---|
| `ActionCard` | Reused heavily by M6 (blast radius) and M8 (approvals) — design for both now |
| `RunTimeline` | Run inspector, Action Center (M8) |
| `ProgramViewer` | AST with executed path; diffable |
| `RiskBadge` / `ReversibilityBadge` | From M1 tokens / M2 |
| `StreamingStatus` | SSE-backed run progress |
| `ClarificationPrompt` | Blocking ambiguity resolution |

---

## 7. APIs

```
POST   /v1/runs                        # { agent_id, objective | trigger_payload }
GET    /v1/runs                        # filter: status, agent, workspace, principal
GET    /v1/runs/:id                    # status + nodes + program
GET    /v1/runs/:id/stream             # SSE progress
POST   /v1/runs/:id/cancel
POST   /v1/runs/:id/input              # answer a blocking clarification (Temporal signal)
GET    /v1/runs/:id/program            # AST + validation result
GET    /v1/runs/:id/replans

GET    /v1/agents/:id/spec
PUT    /v1/agents/:id/spec             # creates a new agent version
POST   /v1/agents/:id/test             # dry run, no side effects (uses simulate only)

Webhooks: run.started · run.completed · run.failed ·
          run.awaiting_input · run.replanned
```

---

## 8. Key Flows

### 8.1 Chat-initiated run

```
User: "Handle the Acme meeting request"
  → C1: objective + entities (Acme → crm:acct_8812, TRUSTED)
       ambiguity: none blocking
  → C2: metadata prompt → Opus 5 → DSL program → validate → persist
  → expand to task_nodes with pre-annotations
  → start Temporal workflow
  → per step: hooks → interpreter → connector
  → stream progress; render action cards
  → COMPLETED; trace assembled
```

### 8.2 Blocking ambiguity

```
"Send the proposal to Acme"  → two proposals found, action is R2 (external send)
  → C1 marks ambiguity blocking
  → HUMAN_INPUT node; run → AWAITING_INPUT
  → UI renders ClarificationPrompt with both candidates
  → user picks v3 → POST /v1/runs/:id/input → Temporal signal
  → C1 updates objective → C2 replans from checkpoint → EXECUTING
```

### 8.3 Failure and replan

```
gcal.create fails CONFLICT (slot taken)
  → activity does not retry (not TRANSIENT)
  → replan trigger: precondition_invalid
  → C2 replans from the last checkpoint; prior committed steps are facts
  → new program links to the run; replans row written
  → execution resumes
```

### 8.4 Restart resilience

```
executor pod is killed mid-run
  → Temporal restores workflow state on a new worker
  → committed activities are NOT re-executed (idempotency keys, M2)
  → the in-flight activity resumes or is retried per its policy
  → for R2/R3 in-flight: mark UNKNOWN, do not retry, escalate to a human
```

The `UNKNOWN` case is deliberate: for an irreversible action whose outcome is uncertain, guessing
is worse than asking. This state is surfaced in the Action Center (M8) as `NEEDS_ATTENTION`.

---

## 9. Technology

| Concern | Choice | License |
|---|---|---|
| Durable execution | Temporal (self-hosted, Postgres backend) | MIT |
| SDK | `@temporalio/worker`, `@temporalio/client` | MIT |
| Planner model | Claude Opus 5 | — |
| Intent/entity model | Claude Sonnet 5 | — |
| Gateway | LiteLLM (M5 adds the routing policy layer) | MIT |
| Streaming | SSE via Fastify | MIT |
| Tracing | OpenTelemetry — `trace_id` ↔ `run_id` | Apache-2.0 |
| Prompt versioning | Langfuse (pinned per run) | MIT |

**DBOS Transact evaluation:** TECHSTACK §8 flags DBOS (MIT, Postgres-native) as a lighter
alternative. Decide by the end of this module — if Temporal's operational weight is slowing a small
team, DBOS is the documented fallback. Keep orchestration behind `packages/orchestration` so the
choice stays reversible.

---

## 10. Security

| Control | Implementation |
|---|---|
| Objective origin | Only an authenticated principal; untrusted content can never be an objective |
| Per-run credentials | Agent machine token minted per run, ≤15 min, scoped to declared tools only |
| Tool allowlist | Enforced from the agent spec **and** re-checked at the gate — spec is not the boundary |
| Step and cost limits | From the spec; exceeded → run aborts, not degrades |
| Fan-out limits | Bounded collections in the DSL (M3) plus `max_fanout` |
| No direct execution | `/v1/tools/:id/execute` is not publicly routable (M2 §7) |
| Cancellation | Always available; cancels holds and stops pending steps |

---

## 11. Testing

| Suite | Tool | Gate |
|---|---|---|
| C1 entity resolution accuracy | Eval set from the beachhead corpus | ≥ 95% |
| C1 ambiguity policy | Unit — no `R2`/`R3` proceeds with unresolved ambiguity | **Blocking, zero tolerance** |
| C2 program validity rate | M3's harness | ≥ 90% first attempt |
| C2 bounds enforcement | Unit | Blocking |
| Executor hook ordering | Integration — asserts receipt-before-effect and capture-before-call | **Blocking** |
| Durability | Chaos: kill the worker mid-run, assert no duplicate effects | **Blocking** |
| At-most-once for R2/R3 | Integration | **Blocking** |
| Replan correctness | Integration — committed steps never re-execute | Blocking |
| E2E chat run | Playwright against sandbox connectors | Blocking |
| Cost/step limits | Integration | Blocking |

### 11.1 The durability suite

Toxiproxy plus deliberate pod kills at every step boundary and mid-activity. Assert after each:
no duplicate side effects in the sandbox account, run state consistent, no orphaned Temporal
workflows. This suite is what earns the right to give an agent write access.

---

## 12. Acceptance Criteria

- [ ] A chat objective produces a validated program and executes end to end against sandbox connectors
- [ ] Entity resolution ≥ 95% on the beachhead eval corpus
- [ ] Program validity ≥ 90% first attempt; one bounded replan on failure
- [ ] Zero cases of an `R2`/`R3` action proceeding with unresolved blocking ambiguity
- [ ] Killing the executor mid-run produces no duplicate side effects
- [ ] `R2`/`R3` actions are never retried after commit; uncertain outcomes go `UNKNOWN`
- [ ] Hook ordering asserted by test — receipt before effect, compensator capture before call
- [ ] All six extension points exist with typed interfaces and loudly warning defaults
- [ ] Run inspector shows the timeline, program, plan diffs, and provenance
- [ ] Agent Studio creates a runnable agent; autonomy shows `SHADOW`, read-only
- [ ] Runs resume correctly after connector re-authorization

---

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Planner emits invalid programs too often | Latency, cost, poor UX | Measure validity from day one (M3 harness); iterate the prompt; expand the DSL rather than loosening validation |
| Hooks retrofitted as later modules land | Ordering bugs in the security-critical path | Define all six interfaces **in this module**, with tests asserting order |
| Temporal operational weight | Slows a small team | `packages/orchestration` abstraction; DBOS fallback decided by module end |
| Replanning loops | Cost blowout | Hard bound of 3 replans; every replan recorded with cause |
| Chat UX built before approvals exist | Rework in M8 | `ActionCard` designed against M8's decision-packet spec now |
| C1 over-asks for clarification | Feels dumber than ChatGPT | Ambiguity policy is reversibility-scaled — only `R2`/`R3` block |

---

## 14. Deliverables

- [ ] `services/control/intent` — C1 with entity resolution and ambiguity policy
- [ ] `services/control/planner` — C2 with validation, bounds, versioning, replan
- [ ] `services/execution/executor` — Temporal workflows, activities, saga scaffolding
- [ ] `packages/orchestration` — orchestrator abstraction (Temporal today)
- [ ] All six extension-point interfaces with warning defaults and ordering tests
- [ ] Migrations: `runs`, `task_nodes`, `actions`, `replans`; `agents.spec_json` populated
- [ ] Chat surface with streaming and action cards
- [ ] Run inspector; Agent Studio v1
- [ ] Durability/chaos suite; C1 and C2 eval sets
- [ ] Temporal vs. DBOS decision recorded in PROJECT.md §25

---

## 15. Notes for the Next Module

Module 5 replaces `policyHook`'s permissive default. Ensure the hook receives the **full node
context** — tool declaration, resolved args with taint, planned effect from `simulate()`, principal,
agent, workspace, and the run's accumulated cost — because retrofitting a field into that signature
later touches every call site. Over-provide the context now.
