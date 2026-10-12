# Module 7 — Implementation Record

> What was built for [module7.md](module7.md), where it lives, and how each acceptance criterion
> is proven. The shape decision (the evidence plane is self-sufficient: content travels with the
> entry, replay needs nothing but the chain, the query door has its own port, the RFC 6962 log is
> computed in-process) is D-16 in [PROJECT.md §25](PROJECT.md).

## Layout

| Path | What |
|---|---|
| `packages/verifier` | **Published, Apache-2.0** (M7a). RFC 8785 JCS, the entry-hash rule, ML-DSA-65 with domain separation, RFC 6962 inclusion/consistency, offline pack verification, the `vega-verify` CLI. Bundled into every pack |
| `packages/contracts/src/evidence.ts` | The published formats: the §5.1 receipt (`ActionReceipt`, snake_case), the replay tape (`ReplayTape`), `policy.activated` |
| `packages/db/evidence-migrations/0001_chain.sql` | `audit_entries` (hash-partitioned by tenant, facets beside the hashed payload), `signing_keys`, `anchors`, `content_objects`, `redactions`, `evidence_packs` + `evidence_pack_builds`, `replay_runs`, `chain_verifications`. **Every table append-only** (statement + row triggers, owner included). `evidence_chain_head()` is the writer's only read |
| `packages/db/src/evidence` | `EvidenceWriter` (INSERT-only role: the locked append, content/anchor/pack/replay rows) and `EvidenceReader` (SELECT-only role: faceted cursor queries, scans, leaves, anchors) |
| `packages/db/migrations/0010_evidence.sql` | One primary-DB resolver: tenant slug → id for the public anchors (`vega_auth` SECURITY DEFINER pattern) |
| `services/evidence/src/chain/` | M7a's writer (JCS, Merkle, keys, pack assembly, verifier bundle) + `service.ts` (the append path) and `facets.ts` |
| `services/evidence/src/content.ts` | The content-addressed store: `cas/<tenant>/<sha256>`, verified on read, redaction = chain entry → row → delete |
| `services/evidence/src/anchor.ts` | Signed tree heads, hourly and on demand; optional RFC 3161 (`HttpTimestamper`, DER request built in-house) |
| `services/evidence/src/verify.ts` | Continuous chain verification with the *verifier's* functions (P0 alert on failure) |
| `services/evidence/src/packs/` | The pack builder (query → entries + redactions + policies in force → anchor → proofs → signed zip → WORM → its own chain entry) and `control-map.md` / README generation |
| `services/evidence/src/replay.ts` | Deterministic replay in DRY mode: interpreter, risk, policy, model |
| `services/evidence/src/trace.ts` | C8: the six questions from the chain |
| `services/evidence/src/app.ts`, `main.ts` | Two doors on two listeners: **append `:3004`** (execution's credential; control's own), **query `:3008`** (control's credential) |
| `services/execution/src/evidence-receipt.ts` | The §5.1 receipt and its content (JCS bytes), the replay tape, `run.program` |
| `services/execution/src/executor/` | `DurablePass` records the tape (call results, extractions, lookups) and hands each receipt the decision actually applied, approval, hold, result |
| `services/execution/src/policy/engine.ts` | Decisions now carry their inputs (risk input, weights, OPA input, preset/bundle, matches) |
| `services/control/src/evidence/client.ts`, `routers/evidence.ts` | The control plane's door: `audit.*`, `traces.*`, `evidencePacks.*`, `replay.*`, `publicEvidence.*`; `policies.activate` appends `policy.activated` with the documents |
| `services/gateway/src/routes/evidence.ts` | The §7 API + `/.well-known/vega/keys`, `/.well-known/vega/anchors/:tenant` (no account) |
| `apps/web` | `/audit` (explorer + chain status + export), `/audit/packs`, `/audit/replay/[actionId]`, `/runs/[id]/trace`; the status indicator on the Action Center |
| `evals/evidence` | The load eval (12-month chain, pack build, offline verification, append p99) |
| `infra/helm`, `infra/tests` | The query port, control ↔ evidence rules, evidence → object storage, the new secrets; plane-separation checks for `:3008` |

## How an action is recorded

```
executor, at the call (after policy → simulate → approval → hold)
  receipt:pre   §5.1 receipt (digests) + content (args, program, decision inputs, replay tape)
    → POST evidence:3004/append (append credential)
      → content → CAS (digest computed by the evidence plane)
      → per-tenant advisory lock → evidence_chain_head() → seq = head + 1, prev_hash
      → entry_hash = SHA-256(JCS({kind, ts, payload}) ‖ prev ‖ tenant ‖ seq) → ML-DSA-65 → INSERT → COMMIT
    → 201 → ONLY THEN capture the compensator, then call the tool
    (no 201 → RECEIPT_UNAVAILABLE: the tool is never called)
  receipt:post  outcome + result digest (+ the result as content)
hourly / on demand   signed tree head over the tenant's log → /.well-known/vega/anchors/<slug>
every 15 min         the chain re-verified from genesis with the published verifier
```

## Decisions worth knowing

- **The evidence plane can answer everything from its own data (D-16).** It has no route to the
  primary database (network policy, plane-separation test [3]), so receipts carry the inputs
  of every decision layer as content: the risk input and weights, the OPA input, the preset and
  bundle versions, the matches, and a replay tape. `policy.activated` entries carry the policy
  documents. Packs, replay and traces read only the chain and the content store.
- **Two doors, two ports, three credentials.** `:3004` opens `/append` only; `:3008` opens
  `/query` and `/public` only, and the execution plane has no network rule to it. Under mTLS,
  Cilium cannot see HTTP paths, so a port is what the network can actually enforce. The source
  recorded on an entry comes from the credential, not from the caller's claim.
- **The writer reads one thing.** `vega_evi_writer` has INSERT on every table and no SELECT
  anywhere. It learns the head through `evidence_chain_head()` (SECURITY DEFINER: `seq` and
  `entry_hash` only). Under the per-tenant lock a failed append rolls back whole, so no
  sequence number is ever burnt; `UNIQUE(tenant, seq)` makes a fork impossible even if the lock
  were bypassed.
- **The RFC 6962 log is computed, not hosted.** Leaf `i` is the entry with `seq = i + 1`, so
  the tree is a pure function of the chain. Proofs use the same format Trillian and Certificate
  Transparency use, and the verifier cannot tell which log produced them. Trillian is an
  adapter for later, not a Phase 1 dependency.
- **One digest rule.** `"sha256:" + hex(SHA-256(bytes))`, with JSON stored as JCS bytes. The
  execution plane computes the digests a receipt names, and the evidence plane re-derives them
  from the bytes it stores. Anyone holding the content can recompute every digest.
- **Replay is DRY by construction.** The only tool port is `TapeTools`: it answers from the
  recorded results, and the call being replayed suspends the interpreter instead of executing.
  A call missing from the tape is refused and reported as a divergence. The evidence service
  holds no connector credential and has no egress to the execution plane. Policy replay uses
  the reference evaluator, which the M5 differential suite proves agrees with the compiled Rego.
- **What the receipt records about policy.** It records the decision actually *applied*, with
  the M3 gate's approval requirement folded in. The tape records the *engine's* decision, which
  is what replay re-derives.
- **Redaction order.** The chain entry comes first (who, when, under which request), then the
  row, then the plaintext is deleted. A crash after the entry leaves plaintext that the next
  attempt removes, never an erasure with no record of it. Redaction needs bodies access plus
  authority over the records.
- **Keys.** The first key starts at the epoch. A rotated key starts "now", which ends its
  predecessor's term (`notAfter` is derived, so rotation is an INSERT). Publishing a second
  public key under an existing id is refused. Development signs with a well-known, loudly
  logged key that tests share, so a laptop database never looks like a rotation.
- **Tier exposure (§14.1).** The chain is written for every plan. Explorer access is by role.
  Packs and replay need the Enterprise exposure flags. Every plan reads its own runs' traces.

## Acceptance criteria (§12)

| Criterion | Status | Proof |
|---|---|---|
| 100% of consequential actions produce a chain entry **before** the side effect | ✅ | `services/evidence/test/receipts.test.ts`: at every provider call, the run's `action.pre` count is checked ≥ the call's seq (0 violations across all runs); entry order `run.program, (pre, post)×n`; a held send has no receipt until released |
| `/append` failure prevents execution (fail closed) | ✅ | Same suite: evidence answering 503 → the draft never reaches the provider; node `RECEIPT_UNAVAILABLE`, run FAILED "no audit receipt could be written" |
| Chain verification passes continuously in every environment | ✅ (job) | `ChainVerifier` runs every 15 min (incremental signatures, full hashes, anchors vs roots), P0-logged on failure; head/verification on the status widget. Proven: 4 tenants × 50 parallel appends verify; a row forged with the writer credential is caught (hash, link, signature) |
| Execution plane cannot read, update or delete evidence, or use the signing key | ✅ | `chain-db.test.ts`: the writer cannot SELECT any table; writer, reader **and owner** refused UPDATE/DELETE/TRUNCATE on all 10 tables/partitions; the append credential gets 401 on `/query` and `/public`; the append listener has no `/query` route. Cluster: `infra/tests/plane-separation.sh` adds execution → `:3008` blocked, `/query` on `:3004` → 404 |
| No sequence gaps under concurrent load | ✅ | 200 concurrent appends over 4 tenants → each exactly 1..50, linked, signed |
| Pack builds in < 60 s for a 12-month single-client query | ✅ **31.9 s** | `evals/evidence` report: 100,000 signed entries over 12 months, client pack of 24,984 entries (99 MB) built in 31.9 s, VERIFIED offline in 53 s; CI size (6,000 entries) on every build |
| Published verifier validates packs **offline** and rejects 10+ tamper variants | ✅ | M7a tamper suite (15 variants) + packs built *from the database*: verified with keys and anchors from `/public`, including `published: ok` (`chain-db`, `receipts`, `control/evidence` suites); the bundled `vega-verify.mjs` runs under plain Node outside the repo |
| Replay reproduces deterministic layers on ≥ 99% of eval runs | ✅ 100% | `receipts.test.ts`: every action of 7 runs (branches, `map` over calls, directory resolution, extraction, calendar writes, a held send, a tenant bundle) replays with interpreter, risk and policy **exact**; zero provider calls during replay. Forged tapes diverge on each layer; a starved tape is refused |
| Redaction removes plaintext while the chain still verifies | ✅ | `chain-db` and `control/evidence`: the content returns 410, a `redaction` entry exists, full verification ok, packs report "1 entry has redacted content" as a warning |
| Anchors published hourly at a stable public URL | ✅ | `Anchorer.start(3_600_000)`; `GET /.well-known/vega/anchors/:tenant` through gateway → control (`evidence_public` system principal) → evidence; control suite resolves a slug to signed heads |
| Audit Explorer: faceted search and direct pack export | ✅ | `/audit`: 11 facets, cursor pagination, receipt expansion with digests that open their content (bodies gated), "Export this view as an evidence pack". API proven in `chain-db` (subject facet, two pages by cursor, risk tier, count) |
| Run trace answers all six C8 questions | ✅ | `TraceBuilder` + `/runs/[id]/trace`; `receipts.test.ts` asserts what / why / tools / influences / policies / approvals and body redaction for viewers without `audit.read_bodies` |
| `control-map.md` maps entry kinds to EU AI Act Art. 12/14/15/26 (and vertical rules) | ✅ | Generated per pack with its counts: Art. 12, 14, 15, 26, 73, FINRA 3110/2210, SEC 17a-4(f), GDPR 17/30, NIST AI RMF, plus what the pack does *not* claim |

## Tests (§11)

| Suite | Where | Result here |
|---|---|---|
| Chain integrity, sequence gaps, append-only (every credential), two doors | `services/evidence/test/chain-db.test.ts` | 12/12 |
| Execution → evidence end to end, fail-closed, replay determinism, divergence, DRY isolation, trace, pack | `services/evidence/test/receipts.test.ts` | 9/9 |
| Roles, plan exposure, redaction, policy activation → chain, public endpoints | `services/control/test/evidence.test.ts` | 9/9 |
| Canonicalization, Merkle, signatures, 15 tamper variants, CLI, standalone bundle | `services/evidence/test/{chain,tamper}.test.ts`, `packages/verifier` | all pass |
| M1 plane test (inbox, layers 2–3) | `services/evidence/test/plane.test.ts` | 9/9 |
| Pack build performance | `evals/evidence` (`pnpm --filter @vega/eval-evidence eval`) | PASS, 31.9 s |
| Browser: receipts → trace, explorer, verify, replay, pack verified offline with published keys and anchors | `e2e/tests/evidence.spec.ts` | written; needs the full stack (Zitadel) |

## External items

- **Trillian.** Not deployed (D-16). The in-process log produces RFC 6962 proofs, and a
  Trillian adapter would change no pack.
- **KMS / HSM custody.** `KeyCustody` is the seam, and only `LocalKeyCustody` (a sealed seed)
  exists. A cloud KMS or HSM adapter — the deliberate non-OSS exception, TECHSTACK §22.2 — and
  the customer-held key (§14.1) are deployment work. Plane-separation [4] already asserts that
  the execution identity cannot read the key.
- **RFC 3161.** The client builds the DER request and checks the PKIStatus. It has not been
  exercised against a real TSA; set `EVIDENCE_TSA_URL` to enable it.
- **WORM.** Packs are written to `S3_BUCKET_EVIDENCE`; Object Lock is the bucket's
  configuration in the cloud account (TECHSTACK §11.3). The content store is deliberately *not*
  WORM, because erasure must be able to delete plaintext.
- **Approval evidence (Module 8).** Receipts record whether approval was required and granted,
  plus the approver role. `approval.by` and `evidence_digest` (what the approver saw) arrive
  with Module 8's approval capture.
- **Model layer.** Replay pins the model and replays its output (the program) from the record.
  Re-sampling a model and comparing semantically needs a model endpoint and is left for M10's
  certification runs.
- **Not run on this machine.** The Playwright E2E needs Zitadel. The Helm chart edits were not
  rendered (no `helm` here), and the plane-separation script needs kind + Cilium. CI runs all
  three.
- **Retention automation** beyond `retain_until` on content (§1.4) is Module 10.
