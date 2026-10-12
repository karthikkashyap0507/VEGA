# Module 9 — Implementation Record

> What was built for [module9.md](module9.md), where it lives, and how each acceptance criterion
> is proven. The shape decision (verification as a seventh hook pair beside the other six;
> deterministic groundedness by default; memory and knowledge owned by the control plane, reaching
> the execution plane only as pinned, already-gated context) is D-18 in [PROJECT.md §25](PROJECT.md).

## Layout

| Path | What |
|---|---|
| `packages/db/migrations/0012_knowledge.sql` | `verifications`, `groundedness_findings`, `runs.verification_summary`; `memories` (the **`memory_taint_gate`** CHECK: `source_taint IN ('TRUSTED','ORG')` — the last of three layers) and `memory_conflicts`; `kb_documents` (the **`kb_external_untrusted`** CHECK: an email attachment or URL is `UNTRUSTED`, no exception) and `kb_chunks`; `retrievals`. `pgvector` HNSW on both embedding columns; RLS forced; verifications/findings/retrievals append-only for `vega_app` |
| `packages/verification` | The engine, pure and tested: `verify(phase, checks)` runs the six in fixed order, cheapest first, fail-fast — ABORT (or post-commit COMPENSATE) stops the rest, recorded SKIPPED, never PASS. The groundedness pipeline: deterministic claim extraction (number/price/date/commitment/fact, with unit and currency normalization), evidence matching (value equality for numbers/prices/dates, lexical overlap otherwise, with contradiction detection), severity by claim kind and risk tier |
| `services/execution/src/verification/engine.ts` | `VerificationEngine`: wires the six checks to the running system — permissions (connector status/scopes, principal/agent active, re-checked *now*, not at plan time), policy (plan-time expectation vs. after generation), conflicts (duplicate outreach in 24h via `actions`, contradictory record updates within the run), exposure (M5's classifier against external recipients and the trusted-contacts list), consequence (simulated effect vs. the plan's egress, and post-commit: who was actually reached vs. who was simulated/approved), groundedness (the run's own reads + the knowledge base, taint-filtered). Persists every verification and finding; keeps `runs.verification_summary` as a running tally |
| `services/execution/src/verification/memory.ts` | `RunMemory`: what a completed run remembers — an explicit `emit({remember:{class,content}})`, taint from the emit itself (the M3 lattice, not the tool), plus task-history metadata (tool + count) from committed actions only |
| `packages/memory` | `MemoryStore`: five classes with their scope and TTL; `propose` applies **the gate** (UNTRUSTED refused before anything is embedded or stored — an event, not a retry), then checks for duplicates (≥ 0.97 similarity) and contradictions (same-topic, different claim) — a contradiction opens a `memory_conflicts` row, never an overwrite; `resolve` (keep/accept/merge/both), `edit`/`delete`/pin/`decay`, `recall` with use tracking and a `needsRevalidation` flag |
| `packages/knowledge` | `embed.ts` (`HashingEmbedder` dev stand-in, `VllmEmbedder` for bge-m3, cached by digest), `rerank.ts` (`LexicalReranker`, `VllmReranker`, RRF), `parse.ts` (structural chunking — Markdown/HTML/DOCX/text natively, PDF/PPTX via Docling — chunks keep their heading path), `store.ts` (`KnowledgeBase.ingest` writes OpenFGA tuples *before* indexing; `.search` is dense+lexical → RRF → rerank → **the ACL gate** (batch-checked for the caller, after retrieval, fails closed) → sensitivity gate (≥ 70 needs `allowSensitive`) → logged as a retrieval row) |
| `services/control/src/knowledge/service.ts` | `KnowledgeService`: owns the KB and memory store; `planningContext()` recalls memories and searches the KB for the objective (TRUSTED/ORG only, belt-and-braces filtered again after the planner contract already restricts it), logs the retrieval, and pins the KB hits on the run's checkpoint — what groundedness checks generated content against, without the execution plane ever touching OpenFGA |
| `packages/contracts/src/planner.ts`, `packages/planner/src/prompt.ts` | `PlannerInput.context` (TRUSTED/ORG memories + KB passages, by schema); the prompt frames it as background facts, never an instruction, and flags `needsRevalidation` |
| `services/control/src/routers/knowledge.ts`, `services/gateway/src/routes/knowledge.ts` | `memories.*` (list/create/update/delete/conflicts/resolve/export — a memory's subject controls it; organization memory needs `knowledge.manage`), `kb.*` (upload/documents/reindex/delete/aclPreview/search), `verifications.*`, `retrievals.*` — the §9 API |
| `packages/approvals/src/packet.ts` | `PacketInput.verification` fills `evidence.unsupported_claims` and a `verification` block (outcome + checks); a groundedness ESCALATE flips `recommended` to `reject`. Omitted entirely, the packet is byte-identical to pre-M9 |
| `apps/web` | `/settings/memory` (grouped by class, edit/pin/stale/delete, conflict resolution inline with both provenance chains, export), `/admin/knowledge` (upload, state/sensitivity/taint, ACL preview dialog, reindex/delete), a verification panel shared by the packet and the run trace (`Question 7`), a retrieval inspector in the trace showing `acl_filtered` |

## How a step is verified

```
executor (pass.ts chain()): policy → simulate
  → preVerify(ctx, {sim, policy, approved, objective, reads})      ← Module 9, new
      permissions → policy(after generation) → conflicts → exposure → consequence → groundedness
      ABORT  → stop 'verify_failure'                 → the run replans (as policy_denial does)
      ESCALATE, not yet approved → folded into the decision as REQUIRE_APPROVAL (one packet, M8)
      ESCALATE, already approved → recorded as WARN ("approved by a person")
  → approval (honours the folded-in decision) → receipt:pre (carries the verification) → capture
  → CALL
  → verify(ctx, {effect, input})                                   ← Module 9, post-commit
      consequence: who was actually reached ⊆ who was simulated/approved
      COMPENSATE → stop 'verify_compensate' → end(FAILED, trigger:'verification') → the saga (M6)
  → receipt:post

run COMPLETED: for each emit — rememberOf(e.data) → MemoryStore.propose(tenantId, {..., sourceTaint: e.taint})
               + task-history from committed actions (tool + count, metadata only)

control (planRun): KnowledgeService.planningContext(run)
  → memory.recall + kb.search (ACL-gated as the principal, TRUSTED/ORG only) → logged as a retrieval
  → PlannerInput.context (background facts) ； KB hits pinned on run.checkpoint.knowledge
```

## Decisions worth knowing

- **Verification is a hook pair, not a service call.** `preVerify` runs after `simulate` and
  before `approval`; `verify` runs after the call and before `receipt:post` (`HOOK_ORDER` in
  `packages/orchestration` now reads `policy, simulate, preVerify, approval, receipt:pre,
  captureCompensator, call, verify, receipt:post`). Like policy (D-14), it has no permissive
  default — `defaultHooks` requires the engine, and `executionHooks` wires it from the same
  tenant facts the policy engine already reads.
- **Deterministic groundedness, by design, not by shortcut.** The spec allows "a small model" for
  claim extraction; what ships is pattern-based (numbers, prices, dates, commitments) with unit
  and currency normalization, matched against the run's own reads and the knowledge base by value
  equality or lexical overlap, with same-kind-different-value flagged as a **contradiction**
  (`ABORT`, not `WARN`). The labeled corpus (`packages/verification/test/corpus.ts`, 30 hand-built
  cases) gives **100% BLOCK precision** and ~90% recall — comfortably over the §13 gate — with no
  model call on the hot path. A `ClaimExtractor` adapter is the seam for an LLM upgrade later.
- **The taint gate is three layers, and the suite holds all three.** `memory.test.ts` writes
  through every path — `MemoryStore.propose` with every non-TRUSTED/ORG label, a conflict
  resolution carrying an untrusted proposal, and a raw SQL `INSERT`/`UPDATE` against both the app
  role and the owner role — and every one is refused. The refusal is an event
  (`memory.rejected_untrusted`) that never holds the refused content.
- **Memory never overwrites.** A proposal about the same subject and class, past the duplicate
  threshold but saying something different, opens a `memory_conflicts` row with both proposals'
  provenance; `resolve()` is the only way an active memory changes, and `merge` marks the result
  `userEdited` (confidence raised, taint TRUSTED) — the system's own paraphrase is never passed
  off as the person's words.
- **The knowledge base's ACL check runs after retrieval, on purpose.** `KnowledgeBase.search` ranks
  first, then batch-checks every candidate document's `can_read` for the caller, and only then
  cuts to `k`; `aclFiltered` is returned and logged so "how much was withheld" is answerable, not
  inferred. A failed OpenFGA call returns zero hits (fail closed) — proven by swapping in a
  `batchCheck` that throws.
- **An email attachment is `UNTRUSTED` however it enters the index** — the database CHECK holds
  this regardless of the application. The §12.1 end-to-end suite (`services/control/test/
  knowledge.test.ts`) uploads the M3 red-team corpus's memory-poisoning entries as attachments,
  confirms they index as `UNTRUSTED` (and are still retrievable — labelled — for inspection), and
  confirms the attacker's marker reaches neither `planningContext()`'s output nor any `memories`
  row in the tenant.
- **Planning context is read-only insurance, twice.** The planner contract (`PlannerInput.context`)
  only admits `TRUSTED`/`ORG` by its zod schema; `KnowledgeService.planningContext` filters to the
  same two taints again before it builds that object, so a bug in either place alone cannot leak
  untrusted content into a prompt.
- **A person who already approved a groundedness escalation is not asked twice.** If the step was
  already under approval for another reason and verification's groundedness check would also
  escalate, `preVerify` downgrades that finding to `WARN` once `approved` is true — the packet
  showed the claim, the person decided, and the record reflects that rather than pausing the run
  on a check that already had its answer.
- **One API line is not implemented:** `POST /v1/kb/sources` (connect a *synced* Drive/SharePoint
  source) is not built — §1.3 scopes P4 to "document ingestion" and a synced connector is its own
  Module 2–shaped piece of work. Uploads (`POST /v1/kb/documents`) cover `upload`,
  `email_attachment` and `url` sourceKinds today; `gdrive`/`sharepoint` stay in the schema's enum
  for when that connector exists.

## Acceptance criteria (§13)

| Criterion | Status | Proof |
|---|---|---|
| No memory can be written from `UNTRUSTED` content by any path (adversarially tested) | ✅ | `packages/memory/test/memory.test.ts` — the store, a conflict resolution, the raw app-role and owner-role SQL, and the full M3 red-team memory-poisoning corpus, all refused; `services/control/test/knowledge.test.ts` — an attachment ingested end-to-end never becomes a memory |
| Contradicting memories raise a conflict; never silent overwrite | ✅ | `memory.test.ts` "never silently overwrite" — a contradiction opens a row, the existing memory stays active until resolved |
| Memory is visible, editable, deletable, and exportable by its subject | ✅ | `services/control/test/knowledge.test.ts` "the subject's control"; `/settings/memory` |
| Memories that influenced a decision appear in that decision's trace | ✅ | The retrieval inspector (`/v1/runs/:id/retrievals`, the trace's "Retrieval inspector" card) lists memory ids and content alongside KB chunks for every retrieval |
| All six verification checks run pre-commit, ordered cheapest-first | ✅ | `packages/verification/test/engine.test.ts` — fixed order regardless of call order, SKIPPED (never PASS) after a stop; `services/execution/test/verification.test.ts` against a real run |
| Groundedness flags unsupported claims with ≥ 90% precision on BLOCK-severity findings | ✅ | `packages/verification/test/groundedness.test.ts` — 100% precision (17/17), ~90% recall, on the 30-case labeled corpus |
| Policy is re-evaluated after generation; a tier increase re-routes to approval | ✅ | `VerificationEngine.policy()`; `services/execution/test/verification.test.ts` |
| Post-commit verification failure triggers compensation automatically | ✅ **BLOCKING** | `services/execution/test/verification.test.ts` "post-commit failure → compensation": an action that reached someone nobody approved is undone, `COMPENSATED`, trigger `verification` |
| ACL-aware retrieval: zero cross-permission leakage in the adversarial suite | ✅ **BLOCKING** | `packages/knowledge/test/kb.test.ts` "★ the ACL gate" — owner-only, workspace-only, cross-tenant, fail-closed, sensitivity gate, taint filter, ACL preview, cascading delete |
| `acl_filtered` counts are surfaced in the retrieval inspector | ✅ | `RetrievalInspector` (`data-testid="acl-filtered"`); `kb.test.ts` asserts the logged count matches |
| Embeddings and reranking run self-hosted; no document content leaves the perimeter | ✅ | `VllmEmbedder`/`VllmReranker` call only `VLLM_EMBEDDINGS_URL`/`VLLM_RERANKER_URL`; production throws without it; dev stand-ins warn loudly that they are lexical, not semantic |
| External attachments are labeled `UNTRUSTED` even after knowledge-base ingestion | ✅ | The `kb_external_untrusted` CHECK (database-enforced); `kb.test.ts` tries to flip it and is refused |
| `verifyHook` default in M4 replaced; its warning removed | ✅ | `defaultHooks` now requires `{preVerify, verify}`; no code path reaches the old warning |

## Test results

- **New Module 9 tests: 71**, across `packages/knowledge` (22: golden-document parsing/chunking,
  RRF, the dev embedder, the lexical reranker, the ACL gate including fail-closed and
  cross-tenant), `packages/memory` (14: the taint gate on every path, never-overwrite, the
  subject's control, recall/decay), `packages/verification` (19: check ordering, groundedness
  unit tests, the 30-case labeled corpus at the precision gate), `services/execution` (6:
  real-run integration against Postgres/DBOS/OpenFGA — escalation with the claim shown, a
  contradiction aborting into a replan, a credential refused at exposure, a same-run duplicate
  refused at conflicts, a read checked for permissions/policy only, and the blocking post-commit
  → compensation case), `services/control` (7: the memory API's ownership rules, the KB API's
  ACL gate from the caller's own request, planning context pinned and logged, and the §12.1
  memory-poisoning suite end to end), and `packages/approvals` (1 file, 3 cases: the packet with
  and without verification, byte-identical when absent).
- **Full suite: 1278 passed**, the same **6 environmental failures** as every prior module
  (Docker-dependent OPA/Rego golden tests and chaos test, Presidio recall) — nothing newly broken.
- `pnpm typecheck` and `pnpm lint` are clean across the monorepo, including `apps/web`.
