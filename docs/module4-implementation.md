# Module 4 — Implementation Record

> What was built for [module4.md](module4.md), where it lives, and how each acceptance criterion
> is proven. The engine decision is D-13 in [PROJECT.md §25](PROJECT.md).

## Layout

| Path | What |
|---|---|
| `packages/orchestration` | The engine seam: `Orchestrator` / `DurableContext` (DBOS adapter), the six extension points (`Hooks`, `StepContext`, `HOOK_ORDER`) with loud permissive defaults |
| `packages/runs` | The run state machine as data (`canTransition`, webhook kinds) and `RunStore`: runs, program versions, the task-node journal, actions, replans, leases, progress events |
| `packages/dsl/src/analysis.ts` | `inputDependencies` (data + control flow), `callBound` (worst-case tool calls), `ambiguityPolicy` |
| `packages/planner/src/dev.ts` | The development planner: an `LlmClient` that reads the same metadata-only prompt, for environments without a model key |
| `services/control/src/agent/intent.ts` | C1: origin, mentions (model or heuristic + registry scan), resolution against directory and trusted contacts, ambiguity with candidates, clarification |
| `services/control/src/agent/planning.ts` | C2: spec program or planner → static validation + bounds + tool allowlist → pre-annotated plan rows → ambiguity policy |
| `services/control/src/agent/coordinator.ts` | Plans, starts and re-plans runs; renews credentials; resumes after re-authorization; schedule triggers; outbound webhook delivery |
| `services/control/src/agent/tokens.ts` | Run-token signing key (dev-generated, deployed from the secret store) |
| `services/control/src/routers/{runs,conversations,webhooks}.ts`, `agents.ts` | Runs, chat threads, Agent Studio (spec/putSpec/test/rotateWebhookSecret), webhook endpoints, the inbound trigger |
| `services/execution/src/executor/` | The durable executor: `DurablePass` (journal + hook chain + crash recovery), the run workflow, the internal run API, execution-plane hook wiring |
| `services/gateway/src/routes/runs.ts` | `/v1/runs*` incl. SSE `/v1/runs/:id/stream`, `/v1/agents/:id/{spec,test,webhook-secret}`, `/v1/conversations*`, `/v1/webhooks*`, `/v1/hooks/agents/:id` |
| `packages/db/migrations/0007_runs.sql` | runs, task_nodes, actions, replans, agent_versions, conversations, trigger_fires, webhook endpoints/deliveries, the `vega_sched` definer functions |
| `apps/web` | Chat (threads, streaming, `ActionCard`, `ClarificationPrompt`), run inspector (`RunTimeline`, `ProgramViewer` with diffs, provenance), Agent Studio |
| `evals/intent` | C1 resolution corpus (≥95%) and C2 validity (≥90% first attempt) |
| `scripts/sandbox-providers.ts` | The provider fakes over HTTP for the local stack and E2E (`CONNECTOR_SANDBOX_URL`, refused in production) |

## How a run works

```
POST /v1/runs | chat message | schedule | webhook
  → C1 (inline): origin check, entities resolved (TRUSTED program inputs), ambiguities recorded
  → coordinator: CREATED → PLANNING → C2 → program vN + pre-annotated task nodes
       ambiguity an R2/R3 call depends on → HUMAN_INPUT node, AWAITING_INPUT (nothing runs)
  → PLANNED → run token minted (≤15 min, tool scopes) → execution /internal/runs/start
  → DBOS workflow (id = run id): interpreter passes over program vN
       every call: journal lookup → policy → simulate → approval → receipt:pre → capture
                   → [journal: running] → CALL → [done|failed|unknown] → verify → receipt:post
       suspend (approval · clarification · re-authorization · credential · hold) = durable recv
       failure → replan request (REPLANNING) → coordinator plans vN+1 → signal → next pass
  → COMPLETED | FAILED | CANCELLED | PLAN_REJECTED | NEEDS_ATTENTION
```

## Decisions worth knowing

- **The journal, not the engine, owns at-most-once.** DBOS never re-runs a completed step, but a
  step that was *in flight* when the process died runs again. So the step body looks the call up
  in `task_nodes` first: a `running` row is the crash window. Reads are repeated; KEYED/NATIVE
  tools are re-invoked with the same idempotency key and the M2 ledger replays a success or
  answers `OUTCOME_UNKNOWN` (a new SDK error code: "claimed and never finished"); anything else
  that is not a read becomes `UNKNOWN` and the run goes to `NEEDS_ATTENTION`. Never a guess.
- **Idempotency key = run + (program version, call_seq).** Node ids repeat across replans and a
  call inside `map` runs many times; the Nth call of a version is unique and stable on replay.
- **Replay determinism.** The interpreter is re-run from the top on every resume. Tool results
  come from the journal; extractions and registry lookups are memoized per workflow (a model does
  not answer the same way twice; the directory can change mid-run); `now` is the program's
  creation time. A call whose arguments differ from its journal row stops the run
  (`nondeterminism`) instead of returning a stale result.
- **Committed effects are facts.** After a replan, a non-read call with the same tool and
  arguments as one committed by an earlier version returns the recorded result (`replayedFrom`)
  instead of running again; the planner is also told what already happened.
- **The gate runs before the hooks.** The M3 gate refuses violations inside the interpreter before
  any port sees the call; its REQUIRE_APPROVAL reaches the approval step as `gate.decision`, and
  the executor holds the call even if an approval hook said PROCEED.
- **An approval covers exactly what was shown**: the key is `v<version>:<call_seq>:<args digest>`.
  A decision for anything else is ignored; a replan needs a new approval.
- **Ambiguity is decided with the plan in hand.** C1 records candidates and a best guess; C2 runs
  `ambiguityPolicy` over the program — an R2/R3 call that depends on the binding through data *or
  control flow* blocks, R0/R1 proceed with the assumption recorded on the node. The executor
  re-checks R2/R3 calls against the entity's source id at run time.
- **Run tokens are verified once, checked on every call.** Execution verifies the JWT at
  start/signal and keeps only its claims (scopes, expiry) — the token is never persisted. The
  expiry check runs inside the step, so its clock-dependent answer is recorded; an expired
  credential holds the run until the coordinator mints a fresh one.
- **Planning stays in the control plane.** Execution cannot call control (network policy); it
  asks for a replan by status and waits on a durable message. Every coordinator action is claimed
  (a status transition or a lease), so replicas can run the loop concurrently.
- **Cross-tenant work discovery** uses SECURITY DEFINER functions owned by `vega_sched` that
  return ids and statuses only (the `vega_auth` pattern of M1); everything else is `withTenant`.
- **Outbound webhooks** use `platform_events` as the outbox, are HMAC-signed by control and
  delivered from the isolated web-fetch pod (`/deliver`: https, public addresses, no redirects).
- **Without a model key** the development planner and mention heuristics stand in and every
  service says so at startup; production refuses to start without a planner model.

## Extension points (§5.6)

| Hook | Owner | M4 behaviour |
|---|---|---|
| `policy` | M5 | `ALLOW` + a warning on every call |
| `simulate` | M6 | M2 `simulate()` for non-reads (reads: a derived no-op effect) |
| `approval` | M8 | Waits when the gate or policy requires approval; warns |
| `receipt` | M7 | `platform_events` + an evidence-plane append when configured; a failed receipt means the call is not made |
| `captureCompensator` | M6 | No-op + warning for non-reads |
| `verify` | M9 | No-op + warning for non-reads |

`StepContext` carries the declaration, arguments with per-leaf taint and sources, the gate's
decision, principal, agent and version, workspace, connector and the run's cost (§15).

## Acceptance criteria (§12)

| Criterion | Status | Proof |
|---|---|---|
| A chat objective produces a validated program and executes end to end against sandbox connectors | ✅ | `services/control/test/runs.test.ts` (in-process planes); E2E `agent-core.spec.ts` against the live stack and the sandbox provider |
| Entity resolution ≥ 95% on the eval corpus | ✅ | `evals/intent` — 35/35 scored entities (32 requests) with the heuristic path |
| Program validity ≥ 90% first attempt; one bounded replan | ✅ dev planner · **external** model | `evals/intent/test/planner.test.ts` 10/10 first try with the development planner; `plan()` allows exactly one replan. The model's rate is measured by the same harness once a key is configured |
| Zero R2/R3 actions with unresolved blocking ambiguity | ✅ | Property test `evals/taint-soundness/test/ambiguity.test.ts` with the interpreter as oracle (mutation-tested: dropping control-flow dependence is caught); runtime check in `DurablePass`; runs + E2E |
| Killing the executor mid-run produces no duplicate side effects | ✅ | `services/execution/test/durability.test.ts`: worker processes SIGKILLed mid-send, mid-read after a committed step, and while waiting for approval; mutation-tested (removing the ledger guard fails it) |
| R2/R3 never retried after commit; uncertain outcomes go UNKNOWN | ✅ | executor tests for the three crash windows; `OUTCOME_UNKNOWN`; `NEEDS_ATTENTION` |
| Hook ordering asserted — receipt before effect, capture before call | ✅ | `executor.test.ts` asserts `HOOK_ORDER` per call and that the pre-receipt row exists when the provider is called |
| Six extension points with typed interfaces and loud defaults | ✅ | `packages/orchestration/src/hooks.ts` |
| Run inspector: timeline, program, plan diffs, provenance | ✅ | `/runs/:id` (E2E navigates timeline across two plan versions and the program) |
| Agent Studio creates a runnable agent; autonomy SHADOW, read-only | ✅ | `/studio`; `putSpec` forces SHADOW and activates the agent; E2E |
| Runs resume after connector re-authorization | ✅ | executor + runs tests; `completeOAuth` resumes waiting runs |
| Cost/step limits; bounds at planning | ✅ | executor limits tests; C2 bounds (`BOUND_EXCEEDED` → PLAN_REJECTED; spec save refused) |

## External items

- **Planner model validity.** Set `ANTHROPIC_API_KEY` (or a LiteLLM key) and run
  `pnpm vitest run evals/intent` with `PLANNER_EVAL_MODEL` to measure the model (§11 target ≥ 90%).
- **Toxiproxy.** §11.1 names Toxiproxy for network faults; the suite kills processes at every
  boundary that matters (mid-call, between steps, while waiting) — network partition injection is a
  follow-up for the cluster suite.
