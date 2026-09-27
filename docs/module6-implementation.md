# Module 6 — Implementation Record

> What was built for [module6.md](module6.md), where it lives, and how each acceptance criterion
> is proven. The placement decision (compensators live with their connectors, the lifecycle is a
> library, holds are rows) is D-15 in [PROJECT.md §25](PROJECT.md).

## Layout

| Path | What |
|---|---|
| `packages/connectors/sdk/src/compensator.ts` | The contract: `capture()` before the call, idempotent `compensate()`, `EXACT`/`APPROXIMATE`, `SILENT`/`NOTIFIES_THIRD_PARTY`, TTL, and `describe()` — the consequence in plain words. `defineHoldOnly` for R2 tools whose only undo is the hold |
| `…/sdk/src/registry.ts`, `runtime.ts` | The registry refuses an R1/R2 tool whose compensator its connector does not ship (an R1 needs a real inverse). `runtime.capture()` / `runtime.compensate()` with the connector's credential; undoing is allowed even if the tool was since disabled |
| `packages/connectors/*/src/index.ts` | The launch compensators (§5.4): Gmail draft/label, Calendar delete/restore/recreate (complete-snapshot capture), Drive revision/permission, Outlook draft/event, SharePoint version/permission, Slack delete; Gmail/Outlook send are hold-only; declared MCP tools call their sibling undo tool |
| `packages/connectors/testing` | The fakes gained what undo needs: Calendar `PUT` and attendee notifications, Drive revisions and permission edits, Graph event cancel, versions and permissions, drafts search |
| `packages/compensators` | The lifecycle: states and moves, TTLs, saga order, bounded retries, sealed tokens, divergence with per-tool tolerance (shared with the M2 simulation harness), blast-radius aggregation, Time-to-Undo stats, edit-and-requeue rules, the one-tap revoke capability and push topics, plain-language remediation, and `ReversibilityStore` |
| `packages/db/migrations/0009_reversibility.sql` | `rollbacks`, `compensations`, `holds`, `blast_radius`, `divergences`, `undo_metrics`, `incidents` — forced RLS; divergences and Time-to-Undo append-only |
| `services/execution/src/reversibility/` | The engine (arm, bind, divergence, holds, rollback + incident), the `vega.rollback` workflow, `/internal/rollbacks`, `/internal/blast-radius`, the dry-run blast radius, ntfy delivery |
| `services/execution/src/executor/` | Capture before the call (a failed capture stops the call), the outcome bound after, divergence abort, holds settled on the row, edited arguments, the saga in `end()` |
| `services/control/src/routers/reversibility.ts` | `holds.*`, `undo.*`, `reversibility.*` — and M5's run release/revoke now commit on the hold row |
| `services/gateway/src/routes/reversibility.ts` | The §7 API plus `/v1/holds/revoke` (public, rate-limited, capability only) |
| `apps/web` | Blast radius panel (run card, inspector "Effects"), hold card (view, edit, one-tap revoke, send now), undo controls and live compensation status (run card, inspector "Undo"), incident screen with remediation steps, `/admin/undo` (Time-to-Undo, incidents, simulation health, phone push topic) |
| `evals/compensation` | The correctness harness against the sandbox providers |

## How an action is made reversible

```
before the call   capture()  → token (pre-state; complete snapshots) sealed in `compensations`
the call          journal running → provider → outcome
after the call    bind: committed/unknown → TTL starts, commit_seq fixed; failed → not_needed
                  divergence(simulated, actual): ABORT → the run stops and is compensated
R2 + hold         hold row (window, sealed artifact, precomputed revokers, capability hash)
                  → push with a Revoke button → the row decides: revoked | released | edited
failure           saga: COMPENSATING → reverse commit order → COMPENSATED | COMPENSATION_FAILED
undo (a person)   control authorizes + confirms → execution `vega.rollback` → same runner
```

## Decisions worth knowing

- **The hold row is the arbiter (§5.5 restart safety).** A person's revoke, release or edit is a
  compare-and-set on `holds.state`, committed by the control plane before the run is woken; the
  executor's timer does the same compare-and-set when the window ends. Whichever commits first is
  what happened — including a revoke committed while no worker was running. A hold whose row
  cannot be read or found is never released: NEEDS_ATTENTION plus a `hold_ambiguous` incident.
- **Revoke is the cheapest thing in the product.** Precomputed revokers (the principal, the
  agent's owner, owners, admins, approvers) are cached in Valkey when the hold opens; revoking
  checks that list — no relationship lookup, no policy call — and needs no confirmation. From a
  push it needs no session at all: the push carries a capability (`hr1.<tenant>.<random>`) that
  can revoke that one hold; only its SHA-256 is stored, the plaintext exists only in the push.
  Releasing early and editing need a signed-in person who may act on the run.
- **Edit changes content, never recipients.** Recipients are what the taint gate and the policy
  judged; changing them is a different action (revoke and ask again). The edited call gets its
  own key, so policy decides it again and it is held again; the diff is kept for Module 10.
- **When the saga runs.** A run that ends FAILED with actions it can still undo (unrecoverable
  failure, §5.8) and a divergence ABORT (§5.7). A run a person cancelled, or one waiting in
  NEEDS_ATTENTION, is not undone automatically: its Undo control is there, with the consequence.
- **The saga stops at the first failed compensation.** Earlier steps are not undone around a
  failed later one (that can leave the world less consistent); the incident lists what was
  undone, what failed and what was deliberately not attempted, with the manual steps.
- **Bounded retries.** Three attempts with durable backoff (2 s, 8 s) for errors a retry can fix;
  permission, missing-record and expired-credential errors fail at once, with a first remediation
  step that can fix them ("reconnect Gmail, then Retry undo").
- **An ambiguous forward failure keeps the undo.** A 5xx on an R1 call might have committed: its
  compensation is bound as `unknown`, not `not_needed`. Compensators that can find their own
  effect without the forward result do (Gmail drafts by Message-ID, Calendar events by the
  idempotency-derived id); the others say plainly that the item must be checked by hand.
- **Third-party-visible undos are confirmed.** `NOTIFIES_THIRD_PARTY` compensations answer 428
  with their own description until `confirm: true`; the UI shows the consequence and asks for
  "Undo and notify them". Automatic sagas do not ask — the run's result lists who was told.
- **Blast radius is a dry run of the program**: reads executed, everything else `simulate()`d,
  through the same gate, before each program version first runs. It never blocks the run.
  Runs whose minimum fidelity is DECLARED are flagged for M10's autonomy cap.
- **DBOS, not Temporal** (D-13): holds are durable `recv` timeouts computed from the row's
  expiry, sagas are durable steps with durable sleeps between retries.

## Acceptance criteria (§12)

| Criterion | Status | Proof |
|---|---|---|
| 100% of registered R1/R2 actions have a tested compensator (build-enforced) | ✅ | The registry refuses otherwise; `evals/compensation` fails the build if an R1/R2 tool has no scenario (hold-only R2s are covered by the hold suite) |
| Compensation success rate ≥ 99% in the harness | ✅ 16/16 | `evals/compensation`: capture → execute → compensate → provider state equals the snapshot (modulo declared-approximate fields) → compensate again: no provider write, no second notification. A partial Calendar restore (mutation) is caught |
| Every compensation failure → incident, audit entry, demotion event | ✅ | `services/execution/test/reversibility.test.ts`: a 403 on undo → failed, CRITICAL incident with remediation steps, paged, `autonomy.demotion_requested`; the `compensation.failed` audit entry is appended to the evidence plane when one is configured (not asserted in the suite) |
| Idempotent: double execution produces one effect | ✅ | Harness step 6; claims are compare-and-set (8 concurrent claims → 1 runs) |
| Strict reverse order of commitment | ✅ | Executor suite (the second event deleted first); order property in `packages/compensators` |
| Revocation from mobile push in < 5 s | ✅ (in-process) | E2E: the push's Revoke action, posted exactly as ntfy's app would → run CANCELLED, nothing sent, asserted < 5 s end to end |
| Revoke needs no login challenge; release-early does | ✅ | Control suite: capability revoke without a session; release refused to anyone who cannot act on the run |
| Holds survive worker restarts; ambiguity → NEEDS_ATTENTION | ✅ | Executor suite: engine shut down mid-hold, revoke committed, restarted → CANCELLED; deleted hold row → NEEDS_ATTENTION + incident |
| Simulation matches actual ≥ 99%; divergence beyond tolerance aborts | ✅ | M2 harness at 100% (same comparison); executor suite: a lying simulation → ABORT → compensated |
| Blast radius reports minimum fidelity honestly | ✅ | Executor suite and E2E ("Simulation fidelity: DERIVED for 1 of 1 action") |
| APPROXIMATE / NOTIFIES_THIRD_PARTY surfaced before commit | ✅ | Undo control and 428 confirmation (control suite, UI) |
| Time-to-Undo measured and dashboarded per action type | ✅ | `undo_metrics`; `/admin/undo`; E2E checks both a revoke and a compensation appear |
| Hold timer accuracy ±1 s | ✅ | Executor suite: release time within 1 s of the recorded expiry |

## External items

- **Live provider sandboxes.** Every compensator is proven against the provider fakes, which
  implement the documented semantics. Real tenants (module2.md §11.1) are needed to confirm them
  — especially Calendar's `PUT` restore, Drive revision downloads and Graph `restoreVersion`.
- **Push delivery is ntfy** (self-hosted). Module 8 owns notifications in general (and FCM); the
  capability endpoint is what any channel's "Revoke" button calls.
- **Blast radius costs a second pass of reads** (and extractions) per program version.
- **Audit receipts** for compensations go to the evidence plane when one is configured; Module 7
  chains them.
