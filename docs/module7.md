# Module 7 — Evidence Plane: Audit, Proof & Replay

> **D3 + C8.** Every action carries a signed, independently verifiable receipt. The product is not
> the log — it is the one-click evidence pack that an auditor can verify **without trusting us**.

| | |
|---|---|
| **Phase** | 1 (months 6–8) |
| **Covers** | D3 (PROJECT.md §8.3), C8 (§7.8), §23 compliance mapping |
| **Depends on** | M1 (plane separation), M3 (provenance), M4 (`receiptHook`), M5 (evaluations), M6 (holds) |
| **Blocks** | M10 (certification signing), enterprise sales |
| **Estimate** | 7–9 engineer-weeks |

---

## 1. Purpose & Scope

### 1.1 Why now, not later

EU AI Act high-risk obligations became enforceable **2 August 2026**. Article 12 requires
automatic, tamper-evident logging with ≥6 month retention; Article 14 requires demonstrable human
oversight with genuine intervention capability; Article 15 imposes cybersecurity obligations;
Article 73 governs forensic preservation. Exposure reaches **€35M or 7% of worldwide turnover**.

The Act does not literally mandate cryptographic logs — but traceability plus security plus
forensic preservation makes hash-chained, signed logs the economically rational implementation,
and it is what auditors ask for.

This is a live buying trigger, not a future one.

### 1.2 What this module delivers

1. **Proof-carrying actions** — a signed receipt per consequential action.
2. **A tamper-evident chain** the execution plane cannot rewrite.
3. **Evidence packs** — filtered, signed, control-mapped archives.
4. **Deterministic replay** — re-run any decision against the state as it was.
5. **A published open-source verifier** — the trust asset.
6. **C8 explainability** — the human-readable trace over the same data.

### 1.3 In scope

- Receipt schema, hash chain, ML-DSA signing service, KMS key custody
- Trillian integration for inclusion/consistency proofs; periodic anchoring
- Content-addressed input storage (required for replay)
- Evidence pack builder with control mapping
- Replay engine with pinned models, policies, and weights
- Standalone verifier, published as open source
- Audit Explorer and the run trace UI
- Redaction-compatible design (digests, not plaintext)

### 1.4 Out of scope

Certification reports (M10 signs them using this module's service) · approval capture (M8 supplies
the data) · retention automation beyond configuration (M10).

---

## 2. Dependencies

| From | Needs |
|---|---|
| M1 | Separate namespace, separate DB credentials, INSERT-only grants, distinct KMS key |
| M3 | `sources`, `derivations`, program AST + digest, pinned model id |
| M4 | `receiptHook` call sites (pre + post), run/node/action ids |
| M5 | `policy_evaluations`, `risk_evaluations` with weights version |
| M6 | Hold and compensation lifecycle events |

---

## 3. Architecture

```
  execution plane                    │  evidence plane (separate everything)
                                     │
  receiptHook(pre)  ──── HTTPS ─────▶│  POST /append   (INSERT-only credential)
  tool executes                      │      │
  receiptHook(post) ──── HTTPS ─────▶│      ▼
                                     │  ┌──────────────────────────────┐
   ✗ cannot read                     │  │ Chain Service                │
   ✗ cannot modify                   │  │ seq · prev_hash · entry_hash │
   ✗ cannot reach the DB             │  └──────────┬───────────────────┘
   ✗ cannot use the signing key      │             ▼
                                     │  ┌──────────────────────────────┐
                                     │  │ Signing Service (KMS/HSM)    │
                                     │  │ ML-DSA-65                    │
                                     │  └──────────┬───────────────────┘
                                     │             ▼
                                     │      Trillian log ── anchoring ──▶ published head
                                     │             │
                                     │  ┌──────────┴──────────┐
                                     │  │ Pack Builder ·      │
                                     │  │ Replay Engine       │
                                     │  └─────────────────────┘
```

**Invariant 1 restated:** the execution plane can append and nothing else. Enforced by network
policy, database grants, and KMS IAM — verified by the M1 policy test, which runs against every
deployment.

---

## 4. Data Model

### 4.1 Evidence database (separate instance)

```sql
-- ============ The chain ============
CREATE TABLE audit_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  seq           bigint NOT NULL,            -- per-tenant monotonic
  ts            timestamptz NOT NULL,
  kind          text NOT NULL,              -- action.pre|action.post|approval|hold|
                                            -- compensation|policy.activated|autonomy.changed|
                                            -- admin|taint.violation
  payload_json  jsonb NOT NULL,             -- the receipt (§5.1)
  payload_digest text NOT NULL,
  prev_hash     text NOT NULL,
  entry_hash    text NOT NULL,
  signature     text NOT NULL,              -- ML-DSA-65
  key_id        text NOT NULL,
  trillian_leaf_index bigint,
  anchor_id     uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, seq),
  UNIQUE (entry_hash)
);
-- append-only enforced by grants + trigger
REVOKE UPDATE, DELETE ON audit_entries FROM vega_evidence_writer;

CREATE TABLE anchors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL,
  chain_head_seq bigint NOT NULL,
  chain_head_hash text NOT NULL,
  tree_size      bigint NOT NULL,
  root_hash      text NOT NULL,
  method         text NOT NULL,             -- trillian|rfc3161|published
  external_ref   text,
  anchored_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence_packs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL,
  query_json   jsonb NOT NULL,
  entry_count  int NOT NULL,
  artifact_ref text NOT NULL,               -- WORM object storage
  digest       text NOT NULL,
  signature    text NOT NULL,
  requested_by uuid NOT NULL,
  built_at     timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz
);

CREATE TABLE replay_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL,
  action_id     uuid NOT NULL,
  original_digest text NOT NULL,
  replay_digest text NOT NULL,
  matched       boolean NOT NULL,
  divergence_json jsonb,
  requested_by  uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
```

### 4.2 Content-addressed store

Every prompt, retrieved document, tool response, and model output is stored by digest in
immutable object storage. Key = `sha256:<digest>`. Deduplicated, referenced by receipts, and
required for replay.

**Retention:** governed by `tenants.retention_days` (floor 180). Content may be redacted; the
chain never is.

---

## 5. Backend

### 5.1 The receipt

```jsonc
{
  "action_id": "act_01J...",
  "run_id": "run_01J...",
  "ts": "2026-08-22T10:14:03.221Z",
  "actor": {
    "principal": "user_88",
    "on_behalf_of": "user_88",
    "agent": "client-comm-v3",
    "agent_identity": "machine_4412"
  },
  "tool": { "id": "gmail.send", "egress": "EXTERNAL", "reversibility": "R2", "decl_version": 3 },
  "arguments_digest": "sha256:...",
  "inputs_read": [
    { "source": "gmail:msg_44", "taint": "UNTRUSTED", "digest": "sha256:..." },
    { "source": "kb:doc_12",    "taint": "ORG",       "digest": "sha256:..." }
  ],
  "program": { "id": "prg_...", "digest": "sha256:..." },
  "model": { "id": "claude-opus-5", "params_digest": "sha256:...", "prompt_version": "v7" },
  "policies_evaluated": [
    { "id": "external-comms-supervision", "version": 7, "decision": "REQUIRE_APPROVAL",
      "citation": "FINRA 2210" }
  ],
  "risk": { "score": 68, "tier": "HIGH", "weights_version": 4, "factors": { } },
  "approval": {
    "by": "user_12", "role": "REGISTERED_PRINCIPAL", "at": "...",
    "evidence_digest": "sha256:...", "latency_ms": 41200,
    "evidence_opened": true, "edited": false
  },
  "hold": { "window_ms": 900000, "released_at": "...", "revoked": false },
  "outcome": "COMMITTED",
  "effect_digest": "sha256:...",
  "prev_hash": "sha256:...",
  "entry_hash": "sha256:...",
  "signature": "ML-DSA-65:..."
}
```

**`evidence_digest` in the approval block is important:** it commits to *exactly what the approver
saw*. An Art. 14 audit asks whether oversight was genuine; a receipt proving which screen was
rendered answers it.

### 5.2 Chain construction

```
entry_hash = SHA256( canonical_json(payload) ‖ prev_hash ‖ tenant_id ‖ seq )
signature  = ML-DSA-65(entry_hash, key held in KMS)
```

- **Canonical JSON** (sorted keys, no insignificant whitespace, fixed number formatting). Publish
  the canonicalization rules — a verifier that cannot reproduce the bytes cannot verify.
- Per-tenant sequences, allocated under a serialized transaction to guarantee no gaps.
- Genesis entry per tenant with a fixed `prev_hash`.
- Entry hashes are pushed to Trillian; leaf index recorded for inclusion proofs.

### 5.3 Signing service

- Separate process, separate service account, key never leaves KMS/HSM.
- The execution plane's IAM role cannot invoke it — enforced and tested.
- ML-DSA-65 (FIPS 204). Post-quantum, because the artifact must outlive its retention period and
  a 7-year books-and-records archive signed with ECDSA is a liability by the time it is read.
- Key rotation: new key id recorded per entry; old public keys published indefinitely so historical
  entries stay verifiable.

### 5.4 Anchoring

Periodically (hourly, and on demand) publish the chain head:

- Trillian signed tree head with tree size and root hash.
- Optional RFC 3161 timestamp from an independent TSA.
- Published head digest available at a stable public URL per tenant.

This is what proves **we** did not rewrite history — including retroactively. Without external
anchoring, a tamper-evident log only proves that whoever holds the key did not tamper *carelessly*.

### 5.5 Redaction-compatible design

The chain commits to **digests, never plaintext**. Message bodies and arguments live in the
content-addressed store, which is separately redactable.

A GDPR erasure request removes the plaintext object; the digest remains; the entry stays
verifiable; the pack notes `content redacted at <date> under <request id>`. This is what makes
"immutable audit" and "right to erasure" coexist — design it in from the first commit, because
retrofitting means rewriting the chain, which is precisely what must be impossible.

### 5.6 Evidence packs

Query → signed archive:

```
evidence-pack-acme-2026-03-to-06.zip
├─ manifest.json           query, counts, build time, digest, signature
├─ entries.jsonl           filtered chain entries, in sequence
├─ proofs/
│  ├─ inclusion.json       Trillian inclusion proofs per entry
│  └─ consistency.json     consistency proof between anchors
├─ policies/               every policy version in force during the window
├─ approvals/              receipts incl. what each approver saw
├─ models.json             model + prompt versions used
├─ control-map.md          §23 mapping: entry kinds → regulatory controls
├─ redactions.json         what was redacted, when, under which request
├─ verifier/               the standalone verifier + instructions
└─ README.md               how to verify without contacting us
```

Target: **< 60 seconds for a 12-month single-client query.**

### 5.7 Deterministic replay

Re-run any decision against the state as it was:

```
1. Load the receipt → program digest, input digests, model + prompt version,
   policy bundle version, risk weights version
2. Fetch inputs from the content-addressed store by digest
3. Pin the model version and prompt; restore recorded time and randomness
4. Re-execute through the M3 interpreter in DRY mode (no side effects)
5. Compare: program output, taint derivations, risk score, policy decision
6. Record match or divergence
```

Deterministic components (interpreter, risk function, policy evaluation) must match **exactly** —
a divergence there is a bug. Model outputs may vary; the replay reports semantic divergence rather
than asserting byte equality, and the deterministic layers are what carry the audit weight.

### 5.8 The verifier — publish it

`packages/verifier`, released as open source (Apache-2.0), distributed inside every pack:

```
$ vega-verify ./evidence-pack-acme-2026-03-to-06.zip

  ✓ Manifest signature valid           (key vega-evidence-2026-Q1)
  ✓ 1,247 entries, sequence complete   (seq 88,412 → 89,658, no gaps)
  ✓ Hash chain intact
  ✓ 1,247 signatures valid
  ✓ Trillian inclusion proofs valid
  ✓ Consistency with anchor 2026-06-30 confirmed
  ⚠ 3 entries have redacted content    (digests still verify)

  VERIFIED
```

**It must run offline, with no network calls to us.** A verifier that phones home is not
independent verification. Publishing it is a deliberate trust asset — it says the guarantee does
not depend on trusting the vendor.

### 5.9 C8 — Explainability

The human-readable view over the same data. Every run answers:

| Question | Source |
|---|---|
| **What** did VEGA do | Committed actions with effects |
| **Why** | Objective, program, per-step reasoning summary |
| **Which tools** | Every call with sensitivity-redacted args and responses |
| **What influenced it** | Retrieved documents and memories with taint levels (M3 graph) |
| **Which policies applied** | Every evaluation with its reason chain (M5) |
| **Was approval required** | Who, when, what they saw, how long they took (M8) |

Traces render for humans and export as machine-readable evidence. Same data, two presentations —
never two sources of truth.

---

## 6. Frontend

### 6.1 Audit Explorer (`/audit`)

- Faceted search: actor, agent, tool, tenant, time, risk tier, decision, data subject, connector.
- Cursor pagination — never offset, these tables get large.
- Row expansion shows the full receipt with digests linked to content (permission-gated).
- Chain status widget: current head, last anchor, verification status (continuously monitored).
- **Export to evidence pack** directly from any filtered view.

### 6.2 Run trace (`/runs/:id/trace`)

Timeline with the six C8 questions answered in order, provenance graph embedded (M3), policy
reason chains inline (M5), approval receipts with the rendered evidence, and a link to replay.

### 6.3 Evidence pack builder (`/audit/packs`)

Query builder with a live entry count, build progress, download, and pack history. Common
templates: "everything about this client," "all external communications this quarter," "all
actions by this agent," "all Critical-tier actions."

### 6.4 Replay viewer

Original vs. replayed side by side: program, taint derivations, risk score, policy decision, model
output. Divergences highlighted with the deterministic layers separated from the model layer.

### 6.5 Verification status

A persistent indicator (Action Center, M8): chain intact, last anchor time, entries since anchor.
Green is not decoration here — a customer's compliance officer checks it.

---

## 7. APIs

```
POST   /v1/audit/append                 # INTERNAL, execution plane only, INSERT-only credential
GET    /v1/audit/entries                # faceted query, cursor paginated
GET    /v1/audit/entries/:id
GET    /v1/audit/head                   # current chain head + last anchor
POST   /v1/audit/verify                 # server-side integrity check
GET    /v1/audit/anchors

POST   /v1/evidence-packs               # { query } → build job
GET    /v1/evidence-packs/:id           # status + download URL
GET    /v1/evidence-packs

POST   /v1/replay/:action_id            # deterministic replay
GET    /v1/replay/:id

GET    /v1/runs/:id/trace               # C8 human-readable trace
GET    /v1/runs/:id/trace/export        # machine-readable

Public (unauthenticated, per tenant):
GET    /.well-known/vega/anchors/:tenant_slug   # published chain heads
GET    /.well-known/vega/keys                   # public keys, incl. rotated
```

The two public endpoints matter: they let an auditor confirm an anchor without an account.

---

## 8. Key Flows

### 8.1 Recording an action

```
executor → receiptHook('pre')
  → POST /append (INSERT-only credential)
  → chain service: allocate seq, compute prev_hash, entry_hash
  → signing service: ML-DSA sign
  → persist; push leaf to Trillian
  → 200 with entry_hash
  → ONLY THEN does the tool execute
  → receiptHook('post') → second entry with the outcome
```

If `/append` fails, **the action does not execute.** Fail closed — an unprovable action is worse
than an undone one.

### 8.2 Building an evidence pack

```
Compliance officer: "everything involving client 8812, March–June"
  → query resolves entries + related policies, approvals, models
  → fetch inclusion proofs from Trillian
  → fetch consistency proof between the period's anchors
  → assemble archive; generate control-map.md
  → sign the manifest; write to WORM storage
  → download link (expiring); pack recorded in evidence_packs
```

### 8.3 Auditor verification (offline, no contact with us)

```
Auditor receives the pack
  → runs ./verifier/vega-verify pack.zip
  → verifier checks signatures against published keys (bundled + fetchable)
  → checks chain continuity and inclusion proofs
  → optionally cross-checks the anchor against /.well-known/vega/anchors/...
  → VERIFIED
```

---

## 9. Technology

| Concern | Choice | License |
|---|---|---|
| Hashing | `@noble/hashes` (SHA-256) | MIT |
| Signing | `@noble/post-quantum` (ML-DSA-65 / FIPS 204) | MIT |
| Alternative signing | liboqs / OpenSSL 3.5+ if FIPS validation required | MIT / Apache-2.0 |
| Verifiable log | Trillian | Apache-2.0 |
| Timestamping | RFC 3161 TSA | — |
| Key custody | Cloud KMS / HSM (**deliberate non-OSS exception**, TECHSTACK §22.2) | proprietary |
| WORM storage | Cloud S3 Object Lock (SeaweedFS only after WORM conformance passes) | — |
| Content store | S3-compatible, immutable, content-addressed | — |
| Verifier | Ours, Apache-2.0, **published** | ours |
| Canonical JSON | JCS (RFC 8785) implementation | MIT |

---

## 10. Security

| Control | Implementation |
|---|---|
| Append-only | INSERT-only DB grant + trigger + network policy + IAM. Four layers, all tested |
| Key isolation | Execution plane's service account cannot invoke the signing key (M1 policy test) |
| Chain integrity | Continuous verification job across all environments; failure is P0 |
| External anchoring | Proves we did not rewrite, retroactively |
| Pack access | `COMPLIANCE_OFFICER` / `AUDITOR` roles; every build is itself an audit entry |
| Content access | Sensitivity-gated; `AUDITOR` sees receipts but not bodies unless granted |
| Redaction abuse | Redactions require a recorded request id and are themselves chain entries |
| Replay isolation | Replay executes in DRY mode with tools stubbed — a replay can never produce a side effect |

**Replay isolation is worth double-checking in review.** A replay that could actually send an email
would turn the audit tool into an attack tool.

---

## 11. Testing

| Suite | Tool | Gate |
|---|---|---|
| **Chain integrity** | Continuous, all environments | **P0 on failure** |
| Append-only enforcement | Adversarial — attempt UPDATE/DELETE with every credential | **Blocking** |
| Plane isolation | Reuses M1's policy test | **Blocking** |
| Signature verification | Unit + cross-implementation | Blocking |
| Canonicalization | Golden vectors; independent implementation cross-check | **Blocking** |
| Sequence gaps | Concurrency test under parallel appends | **Blocking** |
| **Verifier correctness** | Verify valid packs; reject tampered ones (10+ tamper variants) | **Blocking** |
| Replay determinism | Nightly across recent actions | ≥ 99% match on deterministic layers |
| Pack build performance | Load test | < 60s for 12 months |
| Redaction | Redact content, assert chain still verifies | Blocking |
| Fail-closed | Kill the evidence service; assert no action executes | **Blocking** |
| WORM conformance | §11.3 TECHSTACK suite | Blocking on storage version bump |

### 11.1 Tamper variants the verifier must reject

Modify a payload byte · reorder entries · delete an entry · insert a forged entry · replay an old
signature onto new content · alter a `prev_hash` · substitute a key · truncate the chain · forge an
anchor · alter a redaction record.

Each is a test case. A verifier that passes a tampered pack is a total product failure — this suite
is the proof that it does not.

---

## 12. Acceptance Criteria

- [ ] 100% of consequential actions produce a chain entry **before** the side effect
- [ ] `/append` failure prevents execution (fail closed, tested)
- [ ] Chain verification passes continuously in every environment
- [ ] Execution plane provably cannot read, update, or delete evidence, or use the signing key
- [ ] Sequences have no gaps under concurrent load
- [ ] Evidence pack builds in < 60s for a 12-month single-client query
- [ ] The published verifier validates packs **offline** and rejects all 10+ tamper variants
- [ ] Replay reproduces deterministic layers on ≥ 99% of eval runs
- [ ] Redaction removes plaintext while the chain still verifies
- [ ] Anchors published hourly at a stable public URL
- [ ] Audit Explorer supports faceted search and direct pack export
- [ ] Run trace answers all six C8 questions
- [ ] `control-map.md` maps entry kinds to EU AI Act Art. 12/14/15/26 and vertical requirements

---

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Signing latency in the hot path | Slow runs | Sign asynchronously *within* the append transaction; batch where safe; measure p99 |
| Canonicalization drift between our writer and the verifier | Packs fail to verify | Golden vectors + independent cross-implementation test; RFC 8785 |
| WORM storage doesn't actually enforce | Books-and-records claim fails an audit | Conformance suite; cloud Object Lock until an OSS option passes (TECHSTACK §11.3) |
| Chain size and query performance | Slow audit explorer | Partition by tenant/month from day one; cursor pagination only |
| Replay impossible because inputs weren't stored | Certification (M10) is unsupportable | Content-addressed storage is mandatory from M3 — verify it is complete before this module ships |
| Key compromise | Historical entries repudiable | HSM custody, rotation, external anchoring bounds the damage window |
| Over-claiming immutability | Reputational | Language: "tamper-evident," never "tamper-proof" |

---

## 14. Deliverables

- [ ] `services/evidence` — chain, signing, packs, replay (separate namespace, separate creds)
- [ ] Trillian deployment + inclusion/consistency proof integration
- [ ] Anchoring job + public `.well-known` endpoints
- [ ] Content-addressed store with retention and redaction support
- [ ] `packages/verifier` — **published open source**, bundled in every pack
- [ ] Evidence pack builder with control mapping
- [ ] Replay engine in DRY mode with tool stubbing
- [ ] Migrations for the evidence database
- [ ] Audit Explorer, run trace, pack builder, replay viewer, verification status widget
- [ ] Tamper-variant test suite; continuous chain verification job
- [ ] `receiptHook` default in M4 replaced; its warning removed

---

## 14.1 Tier exposure (PROJECT.md §22.1)

The chain is **always written**, for every tenant on every plan — a free-tier action is signed
exactly like an enterprise one. Tiers gate only what is *exposed*:

| Surface | Free / Pro / Business | Teams / Enterprise |
|---|---|---|
| Chain written and signed | always | always |
| Readable run history (C8) | yes | yes |
| Export own history | yes (JSON) | yes |
| Evidence packs with proofs and control map | no | yes |
| Deterministic replay | no | yes |
| Published verifier | yes (public OSS regardless) | yes |
| Customer-held signing key | no | yes, single-tenant and above |

**Never skip writing the chain to save money on a cheap tier.** It is the substrate that M10
certification reads: a tenant with no chain can never be promoted, and a customer upgrading from
self-serve would arrive with no history to certify against. Storage is cheap; missing history is
unrecoverable.

---

## 15. Notes for the Next Module

Module 8 must capture `evidence_digest` — a digest of exactly what the approver saw — and pass it
into the approval receipt. Render the decision packet server-side and hash the rendered payload, so
the digest is meaningful. An approval receipt that cannot prove *what was shown* does not satisfy
Article 14, and M10's override corpus loses the context that makes it valuable.
