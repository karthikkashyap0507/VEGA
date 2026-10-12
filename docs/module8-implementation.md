# Module 8 — Implementation Record

> What was built for [module8.md](module8.md), where it lives, and how each acceptance criterion
> is proven — or, where it needs real approvers rather than code, what is in place to measure it.
> The shape decision (an approval is a row, decided under the rules in one transaction; phone
> approval is WebAuthn on the mobile web; an edit that adds a recipient is approved again) is
> D-17 in [PROJECT.md §25](PROJECT.md).

## Layout

| Path | What |
|---|---|
| `packages/db/migrations/0011_approvals.sql` | `approval_requests`, `approval_decisions` (**the override corpus**: append-only, trigger-enforced), `approval_views` (what was opened, for how long), `approval_batches`, `notification_budget`, `delegations`, `approval_quality`, `webauthn_credentials`, `webauthn_challenges` — forced RLS; cross-tenant discovery as `vega_sched` SECURITY DEFINER functions (ids only) |
| `packages/approvals` | The rules, pure and tested: the **decision packet** renderer (canonical JSON → SHA-256), the structural edit diff, routing (role → person, delegation, separation of duties, escalation chain, self-serve owner), decide-time `mayApprove`, delegation limits, fallback rules, urgency, review moments, the one-tap reject capability, rubber-stamp scoring — and `ApprovalStore` (every read/write, row-locked) |
| `services/execution/src/approvals/orchestrator.ts` | Opens a request when the hook chain pauses a call (routes, renders, hashes, sets expiry/fallback/escalation) and settles it on the executor's timers: escalate, expire → fallback (recorded as an EXPIRY), supersede on `ESCALATE` |
| `services/execution/src/executor/` | The workflow waits on the row (not a bare message); approved edits replace the arguments; an edited call keeps its approval only if its tier did not rise and no recipient was added; the receipt carries `approval.by` and `evidence_digest` |
| `services/control/src/approvals/service.ts` | Everything a person does: queue, packet (its fetch is the server's "they looked"), instrumented evidence, decide (decide-time authorization and re-routing, separation of duties, digest check, corpus row, `approval` chain entry, wake the run), question, one-tap push reject, homogeneous bulk, delegation, WebAuthn registration and phone approval |
| `services/control/src/approvals/dispatcher.ts` | Urgent → push now within the daily budget; otherwise the next review moment (one push + email digest per batch); budget spent → deferred and owners alerted; nightly rubber-stamp job |
| `services/control/src/routers/approvals.ts` | `approvals.*`, `delegations.*`, `approvalQuality.*`, `actionCenter.*` (brief, tasks, security, usage, autonomy) |
| `services/gateway/src/routes/approvals.ts` | The §7 API, `POST /v1/approvals/reject` (no session, capability only), device registration and phone approval |
| `apps/web` | `/approvals` (keyboard queue `j k a r e v ?`, homogeneous bulk, delegation panel, the "nothing needs you — N ran on their own" empty state), `DecisionPacket` (evidence drawer instrumented), `/m/approvals/[id]` (reject: one tap; approve: biometric), the chat run card decides through the packet, the full `/action-center`, `/admin/approvals` (oversight quality) |

## How an approval flows

```
executor: policy/gate → REQUIRE_APPROVAL
  → orchestrator.open: route (role → person; delegation; SoD; owner on self-serve)
                       render packet → JCS → packet_digest; expiry + declared fallback; escalate_at
  → run AWAITING_APPROVAL, waiting on the ROW (timeout = next of escalate_at / expires_at)
control dispatcher: urgent → push now (title + link + one-tap Reject) | else → review-moment batch
person: GET packet (first look recorded) → open evidence (dwell recorded) → decide
  → decide-time authorization → row lock: pending? not expired? same digest? SoD? distinct?
  → decision + corpus row (one transaction) → `approval` entry in the signed chain → wake the run
executor: settle → approved → (edits? re-decide; tier up or new recipient → approve again)
          → hold (M6) → receipt:pre carries approval.by + evidence_digest → the call
timers:   escalate_at → next role up · expires_at → fallback (AUTO_REJECT default), recorded as expiry
```

## Decisions worth knowing

- **The packet is the hashed artifact.** It is rendered once, by the executor, from the pause it
  describes. It is stored verbatim and hashed with the verifier's canonicalizer. A decision names
  the digest it was made on, and a mismatch is refused. The chain's `approval` entry and the
  action's receipt both carry `evidence_digest`, and the packet's bytes are in the content store,
  so anyone can recompute the digest. The web and phone surfaces render the stored packet; they
  assemble nothing.
- **The server measures, not the client.** Latency runs from this person's first fetch of the
  packet to their decision. "Evidence opened" means an evidence view was recorded before the
  decision. Deciding without ever fetching the packet is refused (428). The push reject is the
  one exception, measured from the notification.
- **Decide-time authorization re-routes.** If an assignee who lost the role, or whose delegation
  ended, tries to decide, they are refused, and the request moves to someone who can decide it
  now (`approval.rerouted`).
- **Edits are decided again.** The edited call goes through policy afresh. It keeps its approval
  only if the risk tier did not rise **and** no recipient was added. In the test, adding a
  competitor raised the risk to CRITICAL and policy *denied* it outright; adding a colleague (same
  tier) required a new approval.
- **Asymmetric phone authentication.** Reject and revoke need nothing (the push carries a
  one-use capability, stored only as a hash). Approve needs a WebAuthn assertion *with user
  verification*, bound to that approval by a one-time challenge. A client claiming the mobile
  surface without one is refused.
- **Budgets are per person per day** (default 12, `settings.approvalBudget`). Urgent items
  (Critical tier, or under an hour left) interrupt; everything else waits for a review moment.
  When the budget is spent, items are deferred and the owners are alerted, because the overflow
  is a product bug.
- **Self-serve plans collapse routing, not evidence.** When `approvalRouting` is not exposed, the
  owner approves everything with one daily digest. The packet, corpus, receipt and quality
  scoring are identical (§14.1). The switch is the plan's exposure flag, not the plan's name
  (TIER-001).
- **Rubber-stamp flags.** `IMPLAUSIBLE_SPEED` fires when more than 10% of decisions come faster
  than the packet's reading time (1 s + 20 ms per character). `NO_EVIDENCE_REVIEW` fires when
  evidence is opened on under 60% of HIGH/CRITICAL items. Five decisions are needed before
  either can fire. They are shown as product signals, not marks against people.

## Acceptance criteria (§12)

| Criterion | Status | Proof |
|---|---|---|
| Median approval latency < 10 s; p90 < 45 s for routine tiers | ⏳ measured, not yet proven | Every decision records the server-measured latency; `/admin/approvals` shows median and p10 per approver. The target needs the design partner's real approvers (§11.1), so a usability test is owed |
| **Evidence-open rate > 60%** on HIGH/CRITICAL | ⏳ measured and flagged | `NO_EVIDENCE_REVIEW` fires below 60% (unit and synthetic tests). The real rate depends on real approvers |
| Zero requests without an expiry and a declared fallback | ✅ | `expires_at`/`fallback` are NOT NULL, ESCALATE requires a role (CHECK); the flow suite asserts both on every opened request |
| Notification volume within budget for 100% of tenants | ✅ enforced | `approvals.test.ts`: budget 2 → 2 pushes, the 3rd deferred to a batch, `overflow = 1`, owners alerted |
| Packets server-rendered, deterministic, digest in the M7 receipt | ✅ | Property test (input order does not matter, any shown change changes the digest); stored packet re-hashes to its digest; the flow suite finds `evidence_digest` in the action receipt and the `approval` chain entry, and the content store's bytes hash to it |
| Separation of duties for dual approval | ✅ | The requester (even made ADMIN) is refused; the first approval leaves it pending; the same approver twice → 409; a second distinct approver completes it |
| Authorization re-checked at decide time | ✅ | Role revoked after assignment → 403 and the request re-routed to another approver; a decision on an expired request is refused |
| Edits re-trigger risk; a tier increase forces re-approval | ✅ | Flow suite: content-only edit → the edited email is sent with no new request; a competitor added → re-decided, CRITICAL → DENY, never sent; a colleague added (same tier) → a new request saying why |
| Mobile: approve needs biometric; revoke needs nothing, < 5 s | ✅ / ⚠ | A software P-256 authenticator: registration, then an assertion **without** UV → refused, **with** UV → approved on the `mobile` surface, replay → refused; the mobile surface without step-up → 401. Reject from the push needs only the capability. Revoke < 5 s is Module 6's E2E. ⚠ Built as mobile web (WebAuthn), not an Expo app |
| 100% of decisions write a complete corpus row, with structural edit diffs | ✅ | Every field asserted (latency 8 400 ms, evidence opened and dwell, surface, digest, chars, tier); diff `[{path:'body', op:'changed', before, after}]`; UPDATE/DELETE on the corpus raise; no decided request lacks its row |
| Rubber-stamp flags nightly, visible to compliance | ✅ | Synthetic approver (4 of 12 decisions at 0.9 s) → `IMPLAUSIBLE_SPEED`, `approval.quality_flag` event, visible to a compliance officer and not to a member |
| Action Center complete | ✅ (brief partial) | Brief, tasks by state (hold/approval countdowns), security center (role-gated), usage vs budget, autonomy shell, verification status. The brief has no connector-sourced "urgent messages / upcoming meetings" yet (see below) |
| Keyboard-only queue; axe passes | ✅ / ⏳ | `j k a r e v ?` and focusable controls throughout; the recommended action takes focus. An axe run is part of the E2E environment, not run here |

## Tests

| Suite | Where | Result here |
|---|---|---|
| Packet determinism (property), diff, routing, delegation, fallbacks, rhythm, rubber-stamp | `packages/approvals/test/rules.test.ts` | 20/20 |
| Integrity, telemetry completeness, SoD/dual, decide-time auth, question, bulk, delegation, budget and push reject, phone biometric, rubber-stamp, Action Center | `services/control/test/approvals.test.ts` | 17/17 |
| End to end with the executor, policy engine and signed chain: happy path, expiry → fallback, escalation, three kinds of edit | `services/control/test/approvals-flow.test.ts` | 6/6 (stable across repeated runs) |
| Tenant isolation over the nine new tables | `packages/db/test/isolation.test.ts` | pass |
| Browser: packet, evidence, keyboard approve, hold, sent, Action Center, oversight | `e2e/tests/approvals.spec.ts` | written; needs the full stack (Zitadel) |

## External items

- **Usability test with real approvers (§11.1).** The 10-second median and the 60% evidence-open
  rate are measured and flagged, but proving them needs the design partner's people.
- **Native mobile app (Expo).** Phone approval is a mobile web page using WebAuthn (Face ID /
  Touch ID / Android biometrics through the browser). Pushes use ntfy with deep links to it. A
  native app would wrap the same endpoints.
- **Email digests.** The `DigestMailer` interface exists; the default sender writes to the log.
  A provider (and MJML templates) is deployment work.
- **The brief's connector half.** "Urgent messages, upcoming meetings" need connector reads on a
  schedule (an agent run). The platform half (decisions, holds, attention, questions, incidents,
  autonomy) is live.
- **Unsupported claims** in the packet are an empty list until Module 9 (verification) fills them.
- **Autonomy promotion** is Module 10; the dashboard's rates are real today.
