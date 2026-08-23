# VEGA — Technology Stack

> Companion to [PROJECT.md](PROJECT.md). Every component here traces to a capability in that
> document. **Open source first**, with the exceptions stated explicitly and justified.

**Status:** v0.1
**Last updated:** 2026-08-22
**Rule:** If you add a dependency, add it here with its license and its exit path.

---

## Table of Contents

1. [Principles](#1-principles)
2. [License Policy](#2-license-policy)
3. [Stack at a Glance](#3-stack-at-a-glance)
4. [Language, Runtime & Monorepo](#4-language-runtime--monorepo)
5. [Frontend](#5-frontend)
6. [API & Services](#6-api--services)
7. [Data Layer](#7-data-layer)
8. [Durable Execution](#8-durable-execution)
9. [Capability Interpreter & Sandboxing (D4)](#9-capability-interpreter--sandboxing-d4)
10. [LLM Layer](#10-llm-layer)
11. [Evidence Plane (D3)](#11-evidence-plane-d3)
12. [Identity & Authorization (P1)](#12-identity--authorization-p1)
13. [Policy Engine (C3)](#13-policy-engine-c3)
14. [Retrieval & Memory (C7, P4)](#14-retrieval--memory-c7-p4)
15. [Connectors (P3)](#15-connectors-p3)
16. [Data Classification & DLP](#16-data-classification--dlp)
17. [Observability](#17-observability)
18. [Testing & Evaluation](#18-testing--evaluation)
19. [Infrastructure & Deployment](#19-infrastructure--deployment)
20. [Local Development (Windows)](#20-local-development-windows)
21. [CI/CD](#21-cicd)
22. [What We Deliberately Do Not Self-Host](#22-what-we-deliberately-do-not-self-host)
23. [License Risk Register](#23-license-risk-register)
24. [Build vs. Adopt vs. Fork](#24-build-vs-adopt-vs-fork)
25. [Cost Model](#25-cost-model)
26. [Capability → Technology Traceability](#26-capability--technology-traceability)

---

## 1. Principles

1. **Open source first, and specifically OSI-licensed.** "Source available" is not open source.
   A BSL or SSPL dependency in the serving path is a future forced migration.
2. **Self-hostability is a product requirement, not a preference.** PROJECT.md §9.7 promises
   private VPC and eventually air-gapped deployment. Any dependency that cannot run inside a
   customer's network disqualifies itself from the serving path.
3. **Boring where it doesn't differentiate.** Postgres, not five specialized stores. The
   differentiators (D1–D6) get the engineering; everything else gets a proven default.
4. **One language across planes.** TypeScript end to end so `packages/contracts` types are shared
   between control, execution, and evidence planes. Type-level enforcement is how several
   invariants in PROJECT.md §10.2 are actually enforced.
5. **Every dependency has a documented exit path.** Written before adoption, not during the crisis.
6. **The evidence plane's trust cannot depend on trusting us.** That biases it toward published
   standards and open verifiers (§11).

---

## 2. License Policy

### Green — use freely

`MIT` · `Apache-2.0` · `BSD-2/3-Clause` · `ISC` · `MPL-2.0` · `PostgreSQL` · `Unlicense` · `CC0`

MPL-2.0 is file-level copyleft: safe as long as we don't modify the licensed files themselves.

### Yellow — permitted as an unmodified network service only

`AGPL-3.0` · `LGPL`

**Rules, non-negotiable:**
- Never link AGPL code into our own binaries or import it as a library.
- Run it only as a separate process we talk to over a network protocol.
- Never fork-and-modify without publishing the modifications.
- Never ship AGPL code inside a customer's on-prem bundle without legal review.

The theory: AGPL §13 obliges you to offer source to users interacting with *the AGPL program*
over a network. Running stock Postgres-style infrastructure behind our own service is the
ordinary, accepted case. Linking it into our product is not. When in doubt, assume it is not.

### Red — do not adopt in the serving path

`SSPL` · `BUSL/BSL 1.1` · `Elastic License 2.0` · `Confluent Community` · `Redis Source Available`
· any "free for non-competing use" license

The 2018–2026 relicensing wave (MongoDB → Redis → HashiCorp → MinIO) has a consistent shape:
adopt permissive, gain traction, relicense, force migration. **Assume every VC-backed
infrastructure vendor will relicense.** Prefer Linux Foundation / CNCF-governed projects, which
have not.

### Special case — open-weight model licenses

Llama Community License, Gemma Terms, and similar are **not OSI-approved**. They carry
acceptable-use restrictions and, in some cases, user-count thresholds. Treat them as commercial
terms requiring review before shipping in a customer deployment. Apache-2.0 / MIT open-weight
families (Qwen, Mistral's permissive line, DeepSeek's permissive releases, gpt-oss) are cleaner.

---

## 3. Stack at a Glance

| Layer | Choice | License | Self-host |
|---|---|---|---|
| Language / runtime | TypeScript on Node 22 LTS | Apache-2.0 / MIT | ✅ |
| Monorepo | pnpm workspaces + Turborepo | MIT / MPL-2.0 | ✅ |
| Web | Next.js + React + Tailwind + shadcn/ui | MIT | ✅ |
| API | Fastify (external REST) + tRPC (internal) | MIT | ✅ |
| Validation / contracts | Zod | MIT | ✅ |
| Primary DB | PostgreSQL 16 | PostgreSQL | ✅ |
| ORM / migrations | Drizzle ORM | Apache-2.0 | ✅ |
| Vectors | pgvector (+ pgvectorscale at scale) | PostgreSQL | ✅ |
| Cache / locks / queues | **Valkey** (not Redis) | BSD-3 | ✅ |
| Job queue | pg-boss → BullMQ at scale | MIT | ✅ |
| Durable execution | Temporal (self-hosted) | MIT | ✅ |
| Sandbox / interpreter | Custom restricted DSL + QuickJS fallback | MIT (ours + QuickJS) | ✅ |
| LLM gateway | LiteLLM proxy | MIT | ✅ |
| Self-hosted inference | vLLM | Apache-2.0 | ✅ |
| LLM tracing / evals | Langfuse + Promptfoo | MIT | ✅ |
| PII / DLP | Microsoft Presidio | MIT | ✅ |
| Policy | Open Policy Agent (Rego) | Apache-2.0 | ✅ |
| Fine-grained authz | OpenFGA | Apache-2.0 | ✅ |
| Identity / SSO | Zitadel (or Keycloak) | Apache-2.0 | ✅ |
| Verifiable log | Trillian (+ our chain) | Apache-2.0 | ✅ |
| Post-quantum signing | @noble/post-quantum (ML-DSA) | MIT | ✅ |
| Key custody | Cloud KMS / HSM — **deliberate exception** | Proprietary | ⚠️ §22 |
| WORM object storage | Cloud S3 Object Lock; SeaweedFS w/ caveats | Apache-2.0 | ⚠️ §11.4 |
| Document parsing | Docling | MIT | ✅ |
| Observability | OpenTelemetry + SigNoz (ClickHouse) | Apache-2.0 / MIT | ✅ |
| Testing | Vitest + Playwright + Testcontainers | MIT / Apache-2.0 | ✅ |
| IaC | **OpenTofu** (not Terraform) | MPL-2.0 | ✅ |
| Orchestration | Kubernetes + Helm + ArgoCD | Apache-2.0 | ✅ |
| Secrets | OpenBao (or External Secrets + cloud KMS) | MPL-2.0 | ✅ |
| Frontier models | Anthropic API — **deliberate exception** | Proprietary | ❌ §22 |

---

## 4. Language, Runtime & Monorepo

| Component | Choice | License | Why |
|---|---|---|---|
| Language | TypeScript 5.x | Apache-2.0 | Shared contracts across all four planes; type-level invariant enforcement |
| Runtime | Node.js 22 LTS | MIT | Boring, long support, broadest connector SDK ecosystem |
| Package manager | pnpm | MIT | Strict dependency isolation — prevents a phantom-dependency escape between planes |
| Build orchestration | Turborepo | MPL-2.0 | Fast enough; MPL-2.0 is green. Nx (MIT) is the alternative |
| Linting | ESLint + typescript-eslint | MIT | Custom rules enforce architectural invariants (below) |
| Formatting | Prettier or Biome | MIT | Biome if speed matters |

### Custom lint rules that enforce PROJECT.md §10.2

These are not stylistic — they are the mechanism by which architectural invariants stay true:

- `no-untrusted-in-privileged` — the privileged planner package may not import types carrying
  `UNTRUSTED` taint (invariant 5).
- `no-evidence-write-from-execution` — the execution plane may not import the evidence-plane
  write client except through the append-only interface (invariant 1).
- `require-tool-declaration` — a connector export without a complete `ToolDeclaration` fails the
  build (invariant 4).
- `no-eval` — `eval`, `new Function`, and `vm` outside the sandbox package are build errors.

**Why not Bun/Deno:** both are fine runtimes; Node has the deepest ecosystem for Google/Microsoft
API SDKs and the Temporal SDK, and boring wins in the plumbing layer.

**Why not Python for the agent core:** the taint system (D4) depends on the type system to enforce
invariant 5 at build time. Python's gradual typing cannot enforce it as reliably. Python remains
appropriate for evals and ML tooling, where it is used freely.

---

## 5. Frontend

Six surfaces from PROJECT.md §6.

| Component | Choice | License | Notes |
|---|---|---|---|
| Framework | Next.js (App Router) | MIT | Server components for the audit explorer's large tables |
| UI library | React 19 | MIT | — |
| Styling | Tailwind CSS | MIT | — |
| Components | shadcn/ui on Radix primitives | MIT | Copy-in, not a dependency — no vendor lock, full a11y |
| State / data | TanStack Query | MIT | — |
| Tables | TanStack Table | MIT | Audit explorer, approval queue |
| Charts | Apache ECharts or visx | Apache-2.0 / MIT | Autonomy dashboard, usage analytics |
| Diffs | diff2html / CodeMirror 6 | MIT | Approval "edit before send" and plan diffs |
| Forms | React Hook Form + Zod | MIT | Shared schemas with the backend |
| Realtime | SSE (native) → WebSocket if needed | — | Run status, hold countdown |
| Mobile | React Native + Expo | MIT | Approvals + revoke only (Phase 2) |
| Push | Firebase Cloud Messaging or ntfy | Proprietary / Apache-2.0 | **ntfy** for self-host; FCM for App Store reach |

**Design constraint from D5:** the approval packet must render in under 10 seconds of human
attention. Prefer server-rendered static packets over client-heavy interactivity; the hold
countdown is the only element that needs realtime.

---

## 6. API & Services

| Component | Choice | License | Notes |
|---|---|---|---|
| External HTTP | Fastify | MIT | Fast, schema-first, JSON Schema → OpenAPI for free |
| Internal RPC | tRPC | MIT | End-to-end types between web and control plane |
| Schema / validation | Zod | MIT | Single source of truth for `packages/contracts` |
| OpenAPI | fastify-swagger | MIT | Public `/v1` surface (PROJECT.md §18) |
| Webhooks | Svix (self-hosted) or in-house | MIT | Signed delivery, retries, replay — don't rebuild |
| Rate limiting | @fastify/rate-limit + Valkey | MIT | Per-tenant, per-connector |
| Idempotency | Postgres keyed store | — | Required by §18; every mutating endpoint |
| Service mesh | None initially | — | Four services do not need a mesh. Revisit at Phase 3 |

**Inter-plane transport:** plain HTTP + mTLS between planes, with the IAM boundary enforced at
the infrastructure level (§19). Do not use a shared database connection between the execution
and evidence planes — that would silently violate invariant 1.

---

## 7. Data Layer

| Component | Choice | License | Notes |
|---|---|---|---|
| RDBMS | PostgreSQL 16+ | PostgreSQL | Control plane, execution plane; RLS for tenancy |
| Evidence DB | Separate Postgres instance | PostgreSQL | Separate credentials, separate network policy — the point of §10.2 |
| Vectors | pgvector | PostgreSQL | HNSW; sufficient to ~10M vectors per tenant |
| Vector scale | pgvectorscale | PostgreSQL | Only if pgvector plateaus. Avoid TimescaleDB's TSL-licensed parts |
| Full-text | Postgres native FTS (`tsvector`) | PostgreSQL | Hybrid retrieval with pgvector; no second store |
| ORM | Drizzle ORM | Apache-2.0 | SQL-first, thin, good RLS ergonomics |
| Migrations | drizzle-kit | Apache-2.0 | Checked in, reviewed like code |
| Cache / locks / leases | **Valkey** | BSD-3 | Entity leases (D6), rate limits, batching |
| Job queue | pg-boss | MIT | Start here — one fewer moving part |
| Job queue (scale) | BullMQ on Valkey | MIT | When pg-boss throughput plateaus |
| Connection pooling | PgBouncer | ISC | — |
| Backups | pgBackRest | MIT | PITR; the audit chain makes backup integrity load-bearing |
| HA | Patroni | MIT | Phase 3 |

### 7.1 Valkey, not Redis

Redis relicensed to RSALv2/SSPL in March 2024 and added AGPLv3 back in May 2025. Valkey is the
Linux Foundation BSD-3 fork with broad enterprise adoption and managed offerings from AWS, Google
Cloud, and Oracle. It is drop-in compatible. **Use Valkey.** The AGPL option on Redis 8 makes it
technically usable, but there is no reason to accept the governance risk twice.

### 7.2 Partitioning and retention

`audit_entries`, `actions`, and `overrides` grow without bound. Partition by tenant and month
from day one (pg_partman, PostgreSQL license). Retention differs per table — audit is floor-6-
months (EU AI Act Art. 12), the override corpus is kept indefinitely because it is the moat.

### 7.3 Why not a dedicated vector database

Pinecone/Weaviate/Qdrant are all reasonable, but a separate store means a second consistency
domain, a second backup story, a second thing to run in a customer's VPC, and no ACL-aware
retrieval without duplicating permissions. pgvector inside the same Postgres keeps memory and
its provenance in one transaction. If it ever becomes the bottleneck, Qdrant (Apache-2.0) is the
migration target.

---

## 8. Durable Execution

| Component | Choice | License | Notes |
|---|---|---|---|
| Orchestrator | **Temporal** (self-hosted) | MIT | Workflows = runs; activities = tool calls |
| SDK | `@temporalio/*` | MIT | — |
| Persistence | Temporal on Postgres | — | Avoid adding Cassandra; Postgres backend is fine at our scale |

**Why Temporal:** PROJECT.md §12.2 requires durable sagas with reverse-order compensation,
checkpointing, at-most-once semantics for `R3`, and resumption after restart. Temporal provides
all of it, is MIT, self-hostable, and was independently validated by the market ($300M at $5B,
Feb 2026). Rebuilding this is months of work with no differentiation.

**Explicitly rejected:** Restate (BSL — red list), Inngest (partially source-available; hosted-
first), AWS Step Functions (not self-hostable, violates principle 2).

**Viable alternative:** DBOS Transact (MIT) — durable execution in Postgres with no extra
infrastructure. Lighter than Temporal and worth prototyping in Phase 1 if Temporal's operational
weight slows a small team. Decide by end of Phase 1.

**Mapping to D1:** a Temporal workflow is a run; each activity carries its compensator handle;
Temporal's saga pattern executes compensations in reverse on failure. The `holds` table plus a
Temporal timer implements the hold window — the timer fires the release, and revoke cancels it.

---

## 9. Capability Interpreter & Sandboxing (D4)

**The single most security-critical component in the system. Build this ourselves.**

| Component | Choice | License | Notes |
|---|---|---|---|
| Program representation | Custom restricted DSL (our AST) | ours | Not JavaScript. No dynamic dispatch, no closures over tainted values, no reflection |
| Interpreter | Hand-written TS AST walker | ours | ~2–4k lines. Every value carries a taint label; every tool call is gated |
| Fallback runtime | QuickJS via `quickjs-emscripten` | MIT | Only if the DSL proves too restrictive. Hard memory/time limits |
| Alternative isolation | `isolated-vm` | ISC | V8 isolates. More power, larger attack surface — prefer QuickJS |
| Connector process isolation | gVisor or Firecracker | Apache-2.0 | Phase 3, for third-party/marketplace connectors |
| Schema-constrained extraction | Zod + constrained decoding | MIT | Quarantined model returns typed values only, never prose |

### 9.1 Why a custom DSL rather than sandboxed JS

The interpreter is not just an isolation boundary — it is the **taint propagation engine**. It
must, for every operation, compute the provenance of the result. Retrofitting that onto a general
JS engine means either instrumenting the engine (fragile, slow, endless escape hatches) or
tracking taint outside it (unsound the moment a value round-trips through a builtin).

A restricted DSL with ~20 operations gives sound propagation by construction. It is the enforcement
boundary for PROJECT.md invariants 3 and 5, and it is why `no-eval` is a build error.

### 9.2 DSL constraints

- No user-defined functions, no recursion, no unbounded loops (bounded `map` over typed collections only).
- All tool calls are static references resolved against the registry at parse time.
- Every value is `(value, taint, source_ids[])` — taint is part of the type, not metadata.
- No string concatenation into tool arguments that determine recipients or destinations — those
  arguments accept only `TRUSTED` references from a resolved entity, never a computed string.
- Deterministic: same program + same inputs → same trace. This is what makes replay (D3) work.

### 9.3 Quarantined extractor

Runs in a separate process with no network egress and no tool registry access. Input: untrusted
content. Output: a value conforming to a Zod schema supplied by the planner. Enforced with
constrained decoding where the provider supports it; validated against the schema regardless.
A schema violation is a taint violation event, not a retry.

---

## 10. LLM Layer

### 10.1 Gateway and routing (C4)

| Component | Choice | License | Notes |
|---|---|---|---|
| Gateway | **LiteLLM proxy** (self-hosted) | MIT | 100+ providers, budgets, virtual keys, caching, spend tracking |
| Our router | `packages/router` | ours | Policy layer above LiteLLM — the hard rules in PROJECT.md §7.4 |
| Alternative gateway | Portkey Gateway | Apache-2.0 | Verify current license before adopting |
| Prompt/version registry | Langfuse | MIT | Model + prompt versions pinned per run — required for replay |

LiteLLM delivers most of P5 (usage analytics, budget caps, per-key spend) for free. **Do not
build a gateway.** Our differentiation is the policy layer above it: risk-tier accuracy floors,
taint-based routing restrictions, and residency pinning.

### 10.2 Models

| Role | Model | Rationale |
|---|---|---|
| Planning, High/Critical tier | **Claude Opus 5** | Frontier reasoning where a mistake is consequential; PROJECT.md §7.4 forbids routing down here |
| Routine generation, drafting | **Claude Sonnet 5** | Cost/quality balance for the bulk of work |
| Classification, extraction, triage | **Claude Haiku 4.5** | Quarantined extractor and cheap classification |
| Air-gapped / on-prem | Open-weight via vLLM | See below |

### 10.3 Self-hosted inference

| Component | Choice | License | Notes |
|---|---|---|---|
| Serving | **vLLM** | Apache-2.0 | Continuous batching, OpenAI-compatible API — drops in behind LiteLLM |
| Alternative | SGLang | Apache-2.0 | Better for structured/constrained decoding |
| Local dev | Ollama / llama.cpp | MIT | Developer laptops only |
| Weights | Qwen, Mistral permissive, DeepSeek permissive, gpt-oss | varies | Check each license — see §2 |

**Realistic position:** the quarantined extractor (structured extraction, no tools) runs well on
open weights and is the right first candidate for self-hosting — it is also the highest-volume
call path, so it is where self-hosting pays. The privileged planner should stay on a frontier
model until open weights measurably close the gap on multi-step planning, because planning
quality directly determines error rate, which directly gates autonomy (D2).

Air-gapped deployment (Phase 4+) requires the full stack on open weights. Design the abstraction
now; do not promise the capability yet.

### 10.4 Agent framework — deliberately none

We do **not** adopt LangChain, LlamaIndex, CrewAI, or AutoGen for the core loop.

Reason: the planner emits a program for *our* interpreter (§9), because taint propagation and
tool gating are the product. A general agent framework's control flow would sit exactly where our
enforcement boundary must be. Frameworks are welcome in `evals/` and prototypes; they are not in
the serving path.

The **Model Context Protocol** SDK (MIT) *is* adopted — as the connector interface (§15), not as
a control-flow framework.

### 10.5 Guardrails and eval tooling

| Component | Choice | License | Use |
|---|---|---|---|
| Tracing / prompt registry | Langfuse (self-hosted) | MIT core | Run traces, model/prompt versions, cost |
| Red-team / injection corpus | **Promptfoo** | MIT | CI-gated D4 suite (PROJECT.md §20) |
| Eval assertions | DeepEval or Promptfoo | Apache-2.0 / MIT | Certification replay sets (D2) |
| Content guardrails | NeMo Guardrails / Guardrails AI | Apache-2.0 | Output constraints; secondary to D4 architecture |
| Injection classifier | Open-weight guard models | check license | Defense in depth only — **never the primary control** |

**Stance:** classifier-based injection detection is a mitigation, not a control. PROJECT.md §8.4.6
is explicit — the architecture is the control. Guard models reduce noise; they do not earn a
security claim.

---

## 11. Evidence Plane (D3)

The plane where "open source" is not ideology but a trust requirement: an auditor must be able to
verify our chain **without trusting us**, which means published algorithms and an open verifier.

| Component | Choice | License | Notes |
|---|---|---|---|
| Hashing | `@noble/hashes` (SHA-256) | MIT | Audited, dependency-free |
| Post-quantum signing | `@noble/post-quantum` (ML-DSA / FIPS 204) | MIT | Pure TS, no native build |
| Alternative PQ | liboqs / OpenSSL 3.5+ | MIT / Apache-2.0 | If a native/FIPS-validated path is required |
| Verifiable log | **Trillian** | Apache-2.0 | Merkle log behind Certificate Transparency; battle-tested |
| Log alternative | Sigstore Rekor | Apache-2.0 | Higher-level; opinionated toward artifact signing |
| Anchoring | RFC 3161 TSA, or public CT-style log | — | Periodic chain-head publication (PROJECT.md §8.3.3) |
| Verifier | `packages/verifier`, published OSS | Apache-2.0 (ours) | **Publish this.** It is the trust asset |
| Archive format | Signed ZIP + JSON manifest | — | Evidence packs; no proprietary container |

### 11.1 Chain design

Our `audit_entries` hash chain lives in Postgres (fast queries, tenant scoping). Trillian sits
underneath as the tamper-evidence primitive, receiving entry hashes and producing inclusion and
consistency proofs. Evidence packs ship the entries, the proofs, and the verifier.

Key custody: signing happens in a service the execution plane cannot reach, using a KMS/HSM-held
key. See §22 — this is a deliberate non-OSS exception.

### 11.2 Redaction-compatible design

The chain commits to **digests**, never plaintext (PROJECT.md §11.1). Message bodies live in
separate, redactable storage. A GDPR erasure removes plaintext without breaking the chain; the
digest remains and the entry stays verifiable. Design this in from the first commit.

### 11.3 WORM storage — the honest situation

The beachhead vertical (§4.2) needs genuine WORM for books-and-records. The open-source options
have real problems as of August 2026:

| Option | License | Object Lock / WORM | Verdict |
|---|---|---|---|
| **MinIO** | AGPL-3.0 | Yes | ❌ **Repository archived April 2026.** Maintenance mode Dec 2025, no reviewed patches, no official binaries. Do not start here. |
| **SeaweedFS** | Apache-2.0 | Implemented | ⚠️ Strongest OSS default, but an open issue reports COMPLIANCE mode not enforcing WORM (deletes still succeed). **Must be validated with our own test suite before trust.** |
| **Garage** | AGPL-3.0 | Versioning only, no object lock | ❌ Disqualified for compliance use |
| **Ceph RGW** | LGPL | Yes | ✅ Correct if you already run Ceph; heavy otherwise |
| **RustFS** | Apache-2.0 | Emerging | ⚠️ Too young for compliance-critical storage |
| Cloud S3 Object Lock | Proprietary | Yes, attested | ✅ Compliance-grade, third-party attested |

**Recommendation:** cloud S3 Object Lock (AWS S3, Backblaze B2, or Wasabi) for compliance-grade
WORM in SaaS and single-tenant. SeaweedFS for development, non-compliance buckets, and as the
on-prem path — *conditional on* a WORM conformance test suite in `evals/` proving retention and
legal hold are actually enforced, run on every version bump.

Being wrong here means the evidence plane's central promise fails an audit. Do not take a vendor's
feature matrix as proof; write the test.

### 11.4 Replay support

Deterministic replay (PROJECT.md §8.3.5) requires content-addressed input storage: every prompt,
retrieved document, and tool response stored by digest. Same S3-compatible storage, immutable
bucket, digest as key. Model and prompt versions pinned via Langfuse.

---

## 12. Identity & Authorization (P1)

| Component | Choice | License | Notes |
|---|---|---|---|
| IdP | **Zitadel** | Apache-2.0 | Multi-tenant native, OIDC/SAML/SCIM, Go, self-hostable |
| Alternative IdP | Keycloak | Apache-2.0 | Broadest enterprise SAML support; heavier, tenancy is bolted on |
| Alternative (composable) | Ory Kratos + Hydra | Apache-2.0 | Most flexible, most assembly required |
| Fine-grained authz | **OpenFGA** | Apache-2.0 | Zanzibar-style ReBAC — needed for ACL-aware retrieval (P4) |
| Authz alternative | Cedar | Apache-2.0 | Formally verified; better for policy-as-code, weaker for relationship graphs |
| Session / app auth | Zitadel SDK | Apache-2.0 | Don't hand-roll sessions |
| Connector token storage | OpenBao or cloud KMS envelope encryption | MPL-2.0 | Never plaintext OAuth tokens at rest |

**Zitadel over Keycloak** because PROJECT.md §9.1 requires hard multi-tenancy with agents holding
their own identities — Zitadel models organizations and machine users natively, where Keycloak
requires realm-per-tenant gymnastics. If a design partner demands exotic SAML federation,
Keycloak is the fallback.

**OpenFGA earns its place** at P4: a user must never receive a retrieved chunk from a document
they cannot open. Encoding that in SQL across Drive/SharePoint/CRM permission models is a
relationship-graph problem, which is exactly what OpenFGA is for.

**Agent identity:** each agent is a machine identity in Zitadel with short-lived, per-run,
scope-limited credentials. Never a long-lived service account with blanket mailbox access.

---

## 13. Policy Engine (C3)

| Component | Choice | License | Notes |
|---|---|---|---|
| Evaluation engine | **Open Policy Agent** | Apache-2.0 | CNCF graduated; Rego; decision logs built in |
| Policy authoring | Our YAML DSL → compiles to Rego | ours | Compliance officers never write Rego |
| Testing | OPA test framework + our simulator | Apache-2.0 | Policy simulation gates deployment (§20) |
| Distribution | OPA bundles | Apache-2.0 | Versioned, signed policy bundles per tenant |

### 13.1 Why OPA, and the architectural bonus

OPA's **decision logs** are a native, structured record of every policy evaluation with its
inputs and result — which is exactly what `policy_evaluations` needs and what an EU AI Act Art. 12
audit expects. Compiling our YAML DSL to Rego means we get that for free rather than building an
evaluation-recording layer.

OPA bundles are versioned and signable, satisfying "policies are code, reviewed and deployed like
code" (PROJECT.md §7.3), and policy simulation replays historical actions against a candidate
bundle before it goes live.

**Cedar considered:** better ergonomics, formal verification, but weaker at the arbitrary
predicate logic our risk policies need (taint levels, monetary thresholds, reversibility classes,
certification state). Rego handles that natively. Keep Cedar in mind for pure RBAC if OpenFGA
proves heavy.

### 13.2 Risk scoring

`packages/risk` implements PROJECT.md §13 as plain, versioned TypeScript — **not** a model, not
Rego. It must be readable by a compliance officer, unit-testable, and reproducible on replay.
Weights are data (versioned rows), the function is code.

---

## 14. Retrieval & Memory (C7, P4)

| Component | Choice | License | Notes |
|---|---|---|---|
| Vector store | pgvector | PostgreSQL | Same transaction as provenance — this matters |
| Lexical | Postgres FTS | PostgreSQL | Hybrid with RRF fusion |
| Reranking | bge-reranker / Qwen reranker via vLLM | Apache-2.0 | Self-hosted; cheap and effective |
| Embeddings | Open-weight (bge-m3, Qwen embeddings) via vLLM | Apache-2.0 | Self-hosted keeps document content in our perimeter |
| Chunking | Custom + Docling structure | MIT | Structure-aware beats fixed-size |
| Document parsing | **Docling** | MIT | PDF/DOCX/PPTX/HTML with layout retention |
| Parsing alternative | Apache Tika | Apache-2.0 | Broader format coverage, weaker structure |
| Email parsing | mailparser + `@microsoft/microsoft-graph-client` | MIT | — |
| Calendar | ical.js | MPL-2.0 | — |
| ACL-aware retrieval | OpenFGA check before return | Apache-2.0 | Non-negotiable at P4 |

**Self-hosted embeddings are a deliberate choice.** Sending every document a customer connects to
a third-party embedding API is a data-exposure story we would rather not have in a regulated
sale, and embedding is exactly the workload where open weights are at parity.

**Taint rule enforced here:** retrieved external content is `UNTRUSTED`; internal knowledge base
content is `ORG`. The retriever labels at the source, and C7 refuses memory writes from
`UNTRUSTED` (PROJECT.md §7.7).

---

## 15. Connectors (P3)

| Component | Choice | License | Notes |
|---|---|---|---|
| Protocol | **Model Context Protocol** SDK | MIT | Third-party tool servers attach without bespoke work |
| Google APIs | `googleapis` | Apache-2.0 | Gmail, Calendar, Drive |
| Microsoft | `@microsoft/microsoft-graph-client` | MIT | Outlook, Exchange, SharePoint, Teams |
| Slack | `@slack/web-api` | MIT | — |
| CRM | Provider SDK (beachhead-dependent) | varies | — |
| Web fetch | Playwright (headless) | Apache-2.0 | Isolated, egress-restricted, `UNTRUSTED` by definition |
| Search | Provider API (SearXNG for self-host) | AGPL-3.0 | SearXNG as a network service only — §2 yellow rules |
| HTTP tool | undici | MIT | Allowlisted destinations only |
| OAuth | Zitadel-brokered or per-connector | Apache-2.0 | Scope minimization per tool declaration |

**Every connector package must export a complete `ToolDeclaration` (PROJECT.md §7.5) and a tested
compensator for every non-R0/R3 action, or the build fails.** The lint rule is the enforcement.

**Web fetch is the highest-risk connector**: it ingests arbitrary attacker-controlled content.
Run Playwright in a network-isolated container with no credentials, strip active content, and
label everything `UNTRUSTED` unconditionally.

---

## 16. Data Classification & DLP

Feeds `data_sensitivity` in the risk score (PROJECT.md §13) and the exposure check in C6.

| Component | Choice | License | Notes |
|---|---|---|---|
| PII / PHI detection | **Microsoft Presidio** | MIT | Analyzer + anonymizer; extensible recognizers; multilingual |
| NLP backend | spaCy | MIT | Presidio's engine |
| Secret detection | detect-secrets or Gitleaks | Apache-2.0 / MIT | Credentials in drafts and documents |
| Custom classifiers | Our recognizers on Presidio | MIT | Vertical-specific: account numbers, MRNs, client identifiers |
| Redaction | Presidio anonymizer | MIT | Trace redaction (C8) and evidence-pack sensitivity gating |

Presidio is the single best OSS fit in this stack: MIT, extensible, and it produces confidence
scores that map cleanly onto a 0–100 sensitivity input rather than a boolean.

---

## 17. Observability

| Component | Choice | License | Notes |
|---|---|---|---|
| Instrumentation | **OpenTelemetry** | Apache-2.0 | Trace ID == run ID. Non-negotiable |
| Backend | **SigNoz** (self-hosted) | MIT | Traces + metrics + logs on ClickHouse, one stack |
| Store | ClickHouse | Apache-2.0 | Also the right home for usage analytics (P5) |
| Alternative | Prometheus + Grafana + Tempo + Loki | Apache-2.0 / AGPL | AGPL is acceptable here — internal ops, network service only |
| LLM tracing | Langfuse | MIT | Model-level detail OTel doesn't capture |
| Errors | Sentry (self-hosted) | FSL → Apache-2.0 after 2y | ⚠️ Functional Source License. Self-hosting is permitted; verify terms |
| Uptime | Uptime Kuma | MIT | — |
| Incident | Grafana OnCall or ntfy | AGPL / Apache-2.0 | Compensation failures page (PROJECT.md §12.2) |

**Correlation requirement:** a trace ID, a run ID, and an audit chain sequence number must be
mutually resolvable. When a compensation fails at 3am, the on-call engineer needs to get from the
alert to the trace to the signed chain entry in under a minute.

**Sentry caveat:** FSL is not OSI-approved (it converts to Apache-2.0 after two years).
Self-hosting for our own use is permitted, but it does not belong on the green list. GlitchTip
(MIT) is the clean alternative if that matters.

---

## 18. Testing & Evaluation

PROJECT.md §20 makes evals CI gates. That makes eval tooling production infrastructure.

| Component | Choice | License | Suite |
|---|---|---|---|
| Unit / integration | Vitest | MIT | All |
| E2E | Playwright | Apache-2.0 | Approval flows, revoke-from-mobile |
| Integration deps | Testcontainers | MIT | Postgres, Valkey, Temporal, OPA |
| API contracts | Pact or schema tests | MIT | Connector declarations |
| Red-team / injection | **Promptfoo** | MIT | D4 corpus — blocks the build |
| Eval assertions | DeepEval | Apache-2.0 | D2 certification replay |
| Property testing | fast-check | MIT | Taint propagation soundness, risk-score monotonicity |
| Load | k6 | AGPL-3.0 | Standalone tool, not linked — acceptable |
| Chaos | Toxiproxy | MIT | Compensation-under-failure testing |
| Security scanning | Trivy, Semgrep, OSV-Scanner | Apache-2.0 / LGPL / Apache-2.0 | Supply chain |
| SBOM | Syft + Grype | Apache-2.0 | Required for enterprise procurement |

### 18.1 Suites that are genuinely bespoke

Four things have no off-the-shelf tool and must be built in `evals/`:

1. **Compensator correctness** — execute forward, compensate, assert state equivalence against a
   real (sandboxed) provider account. Per connector, per action.
2. **Simulation accuracy** — assert simulated blast radius equals actual effect (D1).
3. **WORM conformance** — prove retention and legal hold are actually enforced by whatever object
   storage is configured (§11.3). Run on every storage version bump.
4. **Taint soundness** — property-based: no execution path produces a tool call whose arguments
   carry higher taint than the tool declares. This is the D4 correctness proof.

Property-based testing (fast-check) is the right tool for #4 — the space is too large to enumerate
by hand, and a single sound counterexample is worth more than a thousand passing cases.

---

## 19. Infrastructure & Deployment

| Component | Choice | License | Notes |
|---|---|---|---|
| Containers | Docker / OCI | Apache-2.0 | — |
| Orchestration | Kubernetes | Apache-2.0 | k3s for single-tenant and on-prem |
| Packaging | Helm | Apache-2.0 | One chart per deployment mode (P7) |
| GitOps | Argo CD | Apache-2.0 | — |
| IaC | **OpenTofu** | MPL-2.0 | Not Terraform — BSL since 2023, IBM-owned since Feb 2025 |
| Networking | Cilium | Apache-2.0 | **Network policy is how invariant 1 is enforced** |
| Certificates | cert-manager | Apache-2.0 | mTLS between planes |
| Secrets | OpenBao | MPL-2.0 | LF fork of Vault (BSL). Verify current license at adoption |
| Secret sync | External Secrets Operator | Apache-2.0 | Bridges cloud KMS into k8s |
| Ingress | Traefik or Envoy Gateway | MIT / Apache-2.0 | — |
| Registry | Harbor | Apache-2.0 | Signed images (cosign), vulnerability scanning |
| Image signing | Sigstore cosign | Apache-2.0 | Supply chain; pairs with the Trillian choice in §11 |

### 19.1 Plane separation is an infrastructure control

PROJECT.md invariant 1 — the execution plane may append to but never read or modify the evidence
plane — is not enforceable in application code alone. It requires:

- separate Kubernetes namespaces with default-deny Cilium network policies,
- separate database credentials with `INSERT`-only grants on `audit_entries`,
- the signing key in a KMS the execution plane's service account cannot access,
- separate cloud IAM roles, verified by policy test in CI.

An application-layer-only implementation of this invariant is a finding, not a control.

### 19.2 Deployment modes (P7)

| Mode | Shape |
|---|---|
| Multi-tenant SaaS | Managed k8s, regional clusters for residency |
| Single-tenant hosted | Dedicated namespace + dedicated DB + customer-held KMS key |
| Private VPC | Helm chart into the customer's cluster; our control plane, their data plane |
| Air-gapped (Phase 4+) | Full chart + vLLM + open weights; no external egress. **Do not promise early** |

Keeping every serving-path dependency OSS and self-hostable is what makes the last two rows
possible at all — that is the concrete payoff of principle 2.

---

## 20. Local Development (Windows)

| Component | Choice | License | Notes |
|---|---|---|---|
| Shell / environment | **WSL2 (Ubuntu)** | — | Develop in Linux; the containers are Linux |
| Containers | **Podman Desktop** or Rancher Desktop | Apache-2.0 | Fully OSS |
| Alternative | Docker Desktop | Proprietary | ⚠️ Paid above 250 employees / $10M revenue. Fine now, plan the exit |
| Local stack | `docker compose` | Apache-2.0 | Postgres, Valkey, Temporal, OPA, LiteLLM, Langfuse, SigNoz |
| Local models | Ollama | MIT | Quarantined-extractor development without API spend |
| Local S3 | SeaweedFS | Apache-2.0 | Not for WORM testing — see §11.3 |
| Tunneling | Cloudflare Tunnel or localtunnel | Proprietary / MIT | OAuth callbacks from Google/Microsoft |
| DB tooling | DBeaver or psql | Apache-2.0 | — |
| Editor | VS Code | MIT (product is proprietary) | VSCodium (MIT) if it matters |

**Do the work in WSL2, not Windows-native.** Path handling, file watching, and container
performance all differ enough to produce bugs that only appear in CI. `git config core.autocrlf`
should be `input` inside WSL.

`make dev` (or `pnpm dev`) must bring the entire stack up from a cold clone in under five minutes.
When it stops doing that, fix it that day.

---

## 21. CI/CD

| Component | Choice | License | Notes |
|---|---|---|---|
| CI | GitHub Actions | Proprietary (hosted) | Pragmatic default |
| Self-hosted alternative | Forgejo Actions or Woodpecker CI | MIT / Apache-2.0 | If CI must live inside our perimeter |
| CD | Argo CD | Apache-2.0 | GitOps from the manifests repo |
| Migrations | drizzle-kit in a pre-deploy job | Apache-2.0 | Expand/contract; never destructive in one release |
| Dependency updates | Renovate | AGPL-3.0 | Hosted service or self-hosted; not linked into our code |

### Required CI gates (from PROJECT.md §20)

```
lint → typecheck → unit → integration(testcontainers)
  → taint-soundness (property-based)      # blocks
  → redteam-injection (promptfoo)         # blocks — zero successful exfiltrations
  → compensator-correctness               # blocks per connector
  → policy-simulation                     # blocks policy deploy
  → chain-integrity                       # blocks
  → SBOM + Trivy + Semgrep                # blocks on high severity
  → e2e (playwright)
  → build → sign (cosign) → deploy
```

Nightly, non-blocking: simulation accuracy, replay determinism, WORM conformance, certification
replay sets.

---

## 22. What We Deliberately Do Not Self-Host

Three exceptions to the open-source-first principle. Each is a considered trade, not a default.

### 22.1 Frontier models (Anthropic API)

**Why:** planning quality directly determines error rate, which directly gates autonomy (D2),
which is the entire business. Open weights are at or near parity for extraction, classification,
and embedding — which is why those *are* self-hosted (§10.3, §14) — but not yet for reliable
multi-step planning under adversarial input.

**Exit path:** every model call goes through LiteLLM behind our own router interface. Switching
providers or moving to self-hosted open weights is a configuration change plus re-certification of
affected workflows (which D2 requires on any model change anyway). Never call a provider SDK
directly from service code.

### 22.2 Key custody (Cloud KMS / HSM)

**Why:** the evidence plane's guarantee is that *we* cannot rewrite history. A signing key we
hold on disk in a container we operate defeats that claim regardless of the software's license.
Hardware-backed custody with an access log we do not control is stronger evidence than any
self-hosted alternative.

**Exit path:** for on-prem and air-gapped, SoftHSM (LGPL) or YubiHSM. The signing interface is
abstracted (`packages/evidence/signer`); the algorithm (ML-DSA) and the verifier are open, so a
customer can verify without depending on our key infrastructure at all.

### 22.3 Compliance-grade WORM storage

**Why:** §11.3. The open-source options are archived, unproven, or missing the feature. A
books-and-records claim that fails an audit is worse than no claim.

**Exit path:** S3-compatible API throughout, so Ceph RGW or a matured SeaweedFS can replace it
once our WORM conformance suite passes against it.

**Everything else in the serving path is OSI-licensed and self-hostable.** That is what makes
single-tenant, private VPC, and eventually air-gapped deployment (P7) achievable rather than
aspirational.

---

## 23. License Risk Register

Reviewed quarterly. A move to red triggers a migration plan within one quarter.

| Dependency | License | Risk | Trigger | Exit path |
|---|---|---|---|---|
| PostgreSQL | PostgreSQL | 🟢 None | — | — |
| Temporal | MIT | 🟡 VC-backed, precedent exists | Relicense announcement | DBOS Transact (MIT); or fork at last MIT commit |
| Valkey | BSD-3 | 🟢 Linux Foundation governance | — | Already the fork; nowhere left to run |
| LiteLLM | MIT | 🟡 Commercial enterprise tier | Core features move to paid | Portkey Gateway, or our own thin gateway (~2 weeks) |
| Langfuse | MIT core + EE | 🟡 Open-core | Tracing moves to EE | OTel + ClickHouse directly |
| Zitadel | Apache-2.0 | 🟡 VC-backed | Relicense | Keycloak (CNCF-adjacent, Red Hat backing) |
| OPA | Apache-2.0 | 🟢 CNCF graduated | — | — |
| OpenFGA | Apache-2.0 | 🟢 CNCF | — | Cedar, or SQL-encoded ACLs |
| SeaweedFS | Apache-2.0 | 🟡 Small maintainer base | Stall or WORM bug unresolved | Cloud S3 / Ceph RGW |
| MinIO | AGPL-3.0 | 🔴 **Archived Apr 2026** | Already triggered | **Never adopt** |
| Sentry | FSL | 🟡 Not OSI | On-prem terms change | GlitchTip (MIT) |
| OpenBao | MPL-2.0 | 🟢 LF fork | — | Cloud KMS + External Secrets |
| Docker Desktop | Proprietary | 🟡 Headcount threshold | Team > 250 or revenue > $10M | Podman Desktop (already the recommendation) |
| Turborepo | MPL-2.0 | 🟢 File-level copyleft only | — | Nx (MIT) |
| Renovate | AGPL-3.0 | 🟢 Tool, not linked | — | Dependabot |
| Open-weight models | Varies, non-OSI | 🟡 Use restrictions | License change or threshold breach | Apache-2.0 weight families |

### Watch list

Any dependency that is (a) VC-backed, (b) permissively licensed, and (c) monetized by hosting
is a future relicense. Temporal, LiteLLM, Langfuse, and Zitadel all match. None is a reason not
to adopt — each is a reason to keep the abstraction boundary clean and the exit path written.

---

## 24. Build vs. Adopt vs. Fork

| Component | Decision | Why |
|---|---|---|
| Capability interpreter (D4) | **Build** | It *is* the product's security boundary. No adequate OSS equivalent, and taint propagation cannot be bolted on |
| Compensator registry (D1) | **Build** | The moat. Per-connector inverse logic is the defensible work |
| Risk scoring (§13) | **Build** | Must be auditable and explainable line by line; a library would be a black box |
| Autonomy engine (D2) | **Build** | Novel; the override corpus is proprietary |
| Approval UX (D5) | **Build** | Every off-the-shelf approval widget optimizes for the wrong thing (completeness over speed) |
| Audit chain (D3) | **Build on Trillian** | Merkle-log primitives are solved; the receipt schema and evidence packs are ours |
| Durable execution | **Adopt** (Temporal) | Solved, MIT, months of undifferentiated work |
| Policy evaluation | **Adopt** (OPA) | Mature, CNCF, decision logs are a free architectural win |
| LLM gateway | **Adopt** (LiteLLM) | Commodity; also delivers most of P5 |
| Identity | **Adopt** (Zitadel) | Never build auth |
| PII detection | **Adopt** (Presidio) | Extensible, MIT, well-tested recognizers |
| Vector search | **Adopt** (pgvector) | No reason for a second datastore |
| Agent framework | **Neither** | §10.4 — would sit exactly where our enforcement boundary must be |
| Object storage | **Adopt, cautiously** | §11.3; validate WORM with our own suite |

**Rule of thumb:** build where the thing being built is the reason a customer chooses us. Adopt
everywhere else, behind an interface thin enough to swap.

---

## 25. Cost Model

Rough monthly infrastructure at three stages, excluding model inference and salaries.

| Stage | Shape | Est. / month |
|---|---|---|
| **Phase 1** (dev + 1 design partner) | Single small k8s cluster, one Postgres, Temporal, LiteLLM, SigNoz. Self-hosted everything | $300 – $800 |
| **Phase 2** (5–10 customers) | HA Postgres, separate evidence DB, S3 Object Lock, GPU node for embeddings/reranker | $2k – $5k |
| **Phase 3** (single-tenant enterprise) | Per-customer namespace + DB + KMS key; GPU capacity for self-hosted extraction | $1.5k – $4k *per enterprise tenant* |

**Model inference** is the dominant variable cost and is managed by C4 + LiteLLM budgets. Two
structural levers: route classification and extraction to Haiku-class or self-hosted open weights,
and self-host embeddings and reranking entirely (§14), which removes a per-document API cost that
otherwise scales with every connected mailbox.

**Pricing implication:** PROJECT.md §22 prices on governed actions and oversight seats, never on
tokens. Inference is an input cost we optimize, not a line item the customer reasons about. That
only holds if C4's budget caps are enforced from Phase 2 — an ungoverned agent loop is the
fastest way to invert unit economics.

---

## 26. Capability → Technology Traceability

Every capability in PROJECT.md §5, mapped.

| ID | Capability | Primary technologies |
|---|---|---|
| C1 | Intent & Goal Understanding | Claude Opus 5 · Zod · pgvector (entity resolution) |
| C2 | Task Planner | Claude Opus 5 · our DSL · Temporal |
| C3 | Policy & Risk Engine | OPA/Rego · our YAML DSL · `packages/risk` · Presidio |
| C4 | Model Router | LiteLLM · our policy layer · Langfuse (version pinning) |
| C5 | Task Executor & Tools | Temporal · MCP SDK · connector packages · undici |
| C6 | Verification Engine | Presidio · OPA re-evaluation · our simulation diff |
| C7 | Semantic Memory | Postgres + pgvector · self-hosted embeddings via vLLM |
| C8 | Explainability & Trace | OpenTelemetry · Langfuse · Postgres · Presidio (redaction) |
| **D1** | **Reversibility Layer** | **Temporal sagas · `packages/compensators` · Valkey (hold timers) · per-connector `simulate()`** |
| **D2** | **Earned Autonomy** | **Postgres (`overrides`, `certifications`) · DeepEval · our certification harness** |
| **D3** | **Proof-Carrying Actions** | **Trillian · @noble/hashes · @noble/post-quantum (ML-DSA) · KMS/HSM · S3 Object Lock · published verifier** |
| **D4** | **Taint-Tracked Execution** | **Our DSL interpreter · QuickJS (fallback) · Zod-constrained extraction · Promptfoo (CI) · fast-check (soundness)** |
| **D5** | **Escalation & Approval** | **Next.js · React Native + ntfy/FCM · Postgres · SSE** |
| **D6** | **Contention Control** | **Valkey leases · Postgres (`contact_ledger`) · deterministic victim selection** |
| P1 | Identity, RBAC, Tenancy | Zitadel · OpenFGA · Postgres RLS · OpenBao |
| P2 | Workspaces & Shared Agents | Postgres · OpenFGA · Zitadel orgs |
| P3 | Connector Framework | MCP SDK · provider SDKs · Playwright (isolated) |
| P4 | Knowledge Base | Docling · pgvector · Postgres FTS · OpenFGA (ACL-aware) |
| P5 | Usage Analytics & Cost | LiteLLM spend tracking · ClickHouse · SigNoz |
| P6 | Marketplace (Phase 4+) | MCP · gVisor/Firecracker · cosign (publisher signing) |
| P7 | Deployment Modes | Helm · Argo CD · OpenTofu · k3s · vLLM (air-gapped) |

---

## Appendix A — Version Pinning Policy

- **Pin exact versions** for anything in the serving path. `pnpm-lock.yaml` and Helm chart
  versions are committed and reviewed.
- **Model versions are pinned per run** and recorded in the audit receipt (PROJECT.md §8.3.2).
  An unpinned model breaks replay and invalidates certification.
- **Renovate** proposes updates; the CI gates in §21 decide. Security patches are fast-tracked;
  minor versions batch weekly; majors are planned work with a re-certification impact assessment.
- **Any dependency change touching the execution or evidence plane requires re-running the D2
  certification suites** — because PROJECT.md §8.2.4 auto-demotes on connector or model change,
  and the dependency graph is part of that surface.

## Appendix B — Adding a Dependency

Required before merge:

1. License identified and placed in a §2 band. Red-band dependencies are rejected outright.
2. Row added to §23 with the trigger condition and exit path.
3. Confirmed self-hostable, or listed as a §22 exception with justification.
4. If it enters the serving path: which PROJECT.md invariant could it violate, and what test
   proves it does not?
5. Bundle-size / operational-weight impact stated.

*"It's popular" is not a justification. "It's MIT, CNCF-governed, self-hostable, and it saves
three months on undifferentiated work" is.*

---

*End of stack specification. Update this document when you add a dependency, not at the next audit.*
