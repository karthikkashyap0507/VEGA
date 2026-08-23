# Contributing

## Before your first PR

Read [docs/PROJECT.md §10.2](docs/PROJECT.md) (invariants) and the module spec for whatever you are
touching. This codebase has a small number of rules that are not negotiable, and they are not
obvious from reading the code.

---

## The invariants

These are enforced by `pnpm verify:invariants`, ESLint rules, and CI suites. If you find yourself
working around one, stop and raise it — the workaround is the bug.

| # | Invariant | Enforced by |
|---|---|---|
| 1 | Execution plane may append to evidence, never read/modify/delete | Network policy, INSERT-only grant, trigger, KMS IAM, `PLANE-001` |
| 2 | No side effect before its audit entry is committed | Hook-ordering test (M4) |
| 3 | No tool call without a resolved taint level; fails closed | Interpreter gate (M3) |
| 4 | No tool registers without a complete declaration | Type system + DB constraint (M2) |
| 5 | Privileged planner never receives raw untrusted content | `no-untrusted-in-privileged`, `EVAL-001` |
| 6 | Autonomy tier enforced at the executor, not the UI | Integration test (M10) |
| 7 | Inputs content-addressed, model versions pinned per run | Replay determinism suite (M7) |
| 8 | All tiers run one engine; tiers differ only in exposure | `TIER-001` |
| 9 | Undo and taint defense are never entitlement-gated | Code review; `plan_entitlements` has no such key |

Plus two Module 1 rules:

- **Tenant context comes only from verified token claims.** Never a header, query, or body.
  Database access goes through `withTenant()` in `packages/db` — nothing else. (`DB-001`)
- **The product name appears only in `packages/shared/src/brand.ts`.** The rename must stay a
  one-file change. (`BRAND-001`)

---

## Adding a dependency

From [docs/TECHSTACK.md Appendix B](docs/TECHSTACK.md). Required before merge:

1. **License identified** and placed in a band (§2). Red-band — SSPL, BUSL, Elastic License,
   Confluent Community — is rejected outright.
2. **Row added to the license risk register** (§23) with its trigger condition and exit path.
3. **Confirmed self-hostable**, or listed as an explicit exception with justification. Private VPC
   and air-gapped deployment are product requirements, not aspirations.
4. **If it enters the serving path:** which invariant could it violate, and what test proves it
   does not?
5. **Operational weight** stated.

> "It's popular" is not a justification. "It's MIT, CNCF-governed, self-hostable, and saves three
> months of undifferentiated work" is.

---

## Commit and branch conventions

- Branch from `main`: `m1/rls-tenant-isolation`, `m2/gmail-connector`, `fix/session-rotation`
- Conventional commits: `feat(db): force RLS on tenant-scoped tables`
- Reference the module and section in the body when implementing a spec:
  `Implements module1.md §4.1`
- One logical change per PR. A PR that touches an invariant needs its test in the same PR.

---

## Database changes

- **Expand/contract only.** A release never contains a destructive migration.
  Sequence: add nullable → backfill → application switch → make non-null → drop old (next release).
- Every new tenant-scoped table needs RLS enabled **and forced**, plus an entry in the isolation
  suite. A table without an isolation test fails schema-coverage.
- Migrations are committed and reviewed like code.

---

## Tests that block

| Suite | Gate | Why |
|---|---|---|
| Tenant isolation | Blocking | A leak here ends the company |
| Architectural invariants | Blocking | Architecture drift is not a style issue |
| Typecheck + lint | Blocking | The type system enforces invariant 5 |
| Supply chain (Trivy) | Blocking on HIGH/CRITICAL | Enterprise procurement requires it |

Later modules add: taint soundness, red-team injection (zero successful exfiltrations),
compensator correctness, chain integrity. They appear in CI as disabled jobs **on purpose** — so a
missing gate is visible rather than silently absent.

---

## Local development

Develop inside **WSL2** on Windows. Path handling, file watching, and container performance differ
enough from Windows-native to produce bugs that only appear in CI.

```bash
pnpm stack:up      # start dependencies
pnpm dev           # start services
pnpm stack:reset   # nuke volumes and start clean
```

`pnpm dev` from a cold clone must work in under five minutes. When it stops doing that, fix it
that day — it is the single best predictor of how fast the team ships.

---

## What not to do

- Do not bypass `withTenant()` "just for this admin query."
- Do not add a second code path for a plan tier — entitlements gate *exposure*, not logic.
- Do not remove a loud warning from an extension-point default. The warning means the system is
  ungoverned; silence is how an ungoverned deployment reaches a customer.
- Do not use `eval` or `new Function` anywhere outside `packages/interpreter`.
- Do not claim immunity to prompt injection, in code comments or anywhere else. The honest claim
  is that untrusted content is structurally prevented from reaching privileged tools
  (docs/module3.md §10.1).
