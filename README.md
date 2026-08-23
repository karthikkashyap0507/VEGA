# VEGA

> **Reversible, provable, progressively trusted AI execution.**
>
> Every AI agent platform makes agents safe by *restricting* them. VEGA makes agents safe by making
> their actions **reversible, provable, and trusted only as far as they have earned** — so a
> customer can safely run more autonomy here than anywhere else.

> ⚠️ **The name is a placeholder.** "VEGA" has a live US trademark in Class 042 plus four active
> companies in adjacent AI categories. All brand strings live in
> [`packages/shared/src/brand.ts`](packages/shared/src/brand.ts) so the rename is a one-file
> change. See [docs/PROJECT.md §3](docs/PROJECT.md).

---

## Status

**Module 1 — Foundation & Tenancy.** Steps 1–2 of 9 complete.

| Step | | |
|---|---|---|
| 1 | Workspace skeleton compiles | ✅ |
| 2 | Database with RLS ⚠ | ✅ |
| 3 | Identity (Zitadel) | next |
| 4 | Authorization (OpenFGA) | |
| 5 | API surface | |
| 6 | Web shell | |
| 7 | Self-serve signup | |
| 8 | Plane separation ⚠ | |
| 9 | CI gates + invariant enforcement | |

Plan: [docs/module1-implementation-plan.md](docs/module1-implementation-plan.md)

---

## Quick start

```bash
cp .env.example .env

# generate the two local secrets and paste them into .env
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # LOCAL_KEK_BASE64

pnpm install
pnpm stack:up             # Postgres ×2, Valkey, Zitadel, OpenFGA, Jaeger
pnpm db:migrate
pnpm dev
```

**No external accounts are required for Module 1** — the whole stack is self-hosted. The first
paid key you need is Anthropic, at Module 3.

| Service | URL | Credentials |
|---|---|---|
| Web | http://localhost:3000 | — |
| Gateway API | http://localhost:3001 | — |
| Zitadel console | http://localhost:8080 | `admin` / `Password1!` |
| OpenFGA playground | http://localhost:8082 | — |
| Jaeger traces | http://localhost:16686 | — |

Requires Node 22+, pnpm 10+, Docker. On Windows, **develop inside WSL2** — path handling and file
watching differ enough to produce bugs that only appear in CI (docs/TECHSTACK.md §20).

### Task runner

`typecheck`, `lint`, and `test` run from a **single root project** rather than through Turborepo.
Turbo cannot resolve pnpm when it is installed as an npm-global shim (`cannot find binary path`),
and nested `pnpm` calls inside package scripts fail the same way — both are common on Windows.
One root `tsc` project is also faster than 21 separate processes at this size. `turbo.json` is
kept for when build caching earns its place; revisit once the team is on WSL2 or CI.

---

## Documentation

| Document | What it is |
|---|---|
| [docs/PROJECT.md](docs/PROJECT.md) | **The build bible.** Thesis, capabilities, architecture, data model, phases, decision log |
| [docs/TECHSTACK.md](docs/TECHSTACK.md) | Every dependency, its license, and its exit path |
| [docs/module1.md](docs/module1.md) … [module10.md](docs/module10.md) | Per-module specifications |
| [docs/module1-implementation-plan.md](docs/module1-implementation-plan.md) | The current step-by-step plan |

---

## Repository layout

```
apps/web/              Next.js — the six product surfaces
services/
  gateway/             Public /v1 REST, authn, tenant resolution      [control plane]
  control/             tRPC internal API                              [control plane]
  execution/           Interpreter, orchestrator, connectors          [execution plane]
  evidence/            Audit chain, signing, packs, replay            [evidence plane]
packages/
  shared/              brand.ts, errors, ids, logging, crypto         M1
  contracts/           Zod schemas shared across all planes           M1
  db/                  Drizzle, RLS tenant helper, migrations         M1
  authz/               OpenFGA client and model                       M1
  telemetry/           OpenTelemetry setup                            M1
  eslint-rules/        Architectural invariant rules                  M1
  connectors/          MCP-compatible connectors                      M2
  taint/ dsl/ interpreter/   Capability interpreter, taint lattice    M3
  orchestration/       Durable execution abstraction                  M4
  policy-engine/ risk/ Policy DSL → Rego, risk scoring                M5
  compensators/        Per-tool inverse actions                       M6
  verifier/            Standalone chain verifier (published OSS)      M7
  memory/ knowledge/   Semantic memory, knowledge base                M9
evals/                 CI-gated eval suites (red-team, compensation…)
policies/              Versioned policy packs
infra/                 docker/ k8s/ tofu/
```

---

## The four planes

Separation is a **security control enforced by infrastructure**, not a diagram.

```
experience  →  control  →  execution  ──append-only──▶  evidence
                                        ✗ read  ✗ modify  ✗ delete
```

The execution plane can append to the evidence plane and nothing else — enforced by network
policy, INSERT-only database grants, a trigger, and KMS IAM. Four layers, all tested.
See [docs/PROJECT.md §10.2](docs/PROJECT.md).

---

## Non-negotiable invariants

Violating any of these is a P0 architecture defect, not a bug. `pnpm verify:invariants` checks
what is statically checkable; the rest are covered by CI suites.

1. The execution plane can append to the evidence plane but never read, modify, or delete it.
2. No side effect occurs before its audit entry is committed.
3. No tool call executes without a resolved taint level — unresolved provenance fails closed.
4. No tool registers without a complete declaration.
5. The privileged planner never receives raw untrusted content — enforced by type, not by prompt.
6. Autonomy tier is enforced at the executor. UI-level enforcement is not enforcement.
7. Every input is content-addressed and every model version pinned per run, or replay is impossible.

Two more from the tiering decisions:

8. All tiers run one engine; tiers differ only in what is **exposed** (D-09).
9. Undo and taint defense are **never** entitlement-gated, including on the free tier (D-10).

---

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before your first PR — particularly the invariants and the
dependency-addition checklist. Adding a dependency requires a license band, an exit path, and an
answer to "which invariant could this violate?"

---

## License

Not yet determined. The chain verifier in `packages/verifier` ships Apache-2.0 as a deliberate
trust asset (decision D-07).
