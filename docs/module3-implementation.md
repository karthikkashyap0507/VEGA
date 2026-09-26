# Module 3 — Implementation Record

> What was built for [module3.md](module3.md), where it lives, and how each acceptance criterion
> is proven. The customer-facing claims are in [security-position.md](security-position.md).

## Layout

| Path | What |
|---|---|
| `packages/taint` | Lattice (`join`, `leq`, `gt`), `TaintedValue` (minted only here: unique-symbol brand + runtime registry), `derive`, `endorse`, digests |
| `packages/dsl` | AST + JSON schema, text parser and printer, static validator with static taint inference |
| `packages/interpreter` | Evaluator, tool gate, extraction schemas, render templates (exfil neutralization), ports, memory + Postgres recorders, entity registries, ntfy pager, planner metadata builder, extractor client, test doubles (`/testing`) |
| `packages/planner` | Metadata-only prompt contract, output parsing, one bounded re-plan, validity measurement |
| `packages/llm` | Minimal Messages-API client (forced structured output), scripted client for tests |
| `services/extractor` | The quarantined extractor (no tools, no credentials, model egress only) |
| `services/execution/src/programs.ts` | Internal program API: run / dry run / validate / catalog; adapters to the M2 connector runtime |
| `services/control/src/routers/programs.ts` | `programs` (validate, dryRun, provenance), `security` (violations, acknowledge), `contacts` |
| `services/gateway/src/routes/programs.ts` | `/v1/programs/*`, `/v1/runs/:runId/provenance`, `/v1/security/taint-violations`, `/v1/trusted-contacts` |
| `packages/db/migrations/0006_taint.sql` | `sources`, `derivations`, `taint_violations` (no DELETE grant), `programs`, `trusted_contacts` |
| `packages/eslint-rules` | `no-untrusted-in-privileged` enabled for `packages/planner/src`; new `no-taint-cast` |
| `evals/taint-soundness` | Seven fast-check properties (six from §11.2 plus agreement with static inference) |
| `evals/redteam` | 207-case corpus (14 categories × 9 encodings), runner, Promptfoo config for the live extractor |
| `infra/helm/platform` | Extractor workload, certificate, Cilium policy (ingress from execution, egress DNS + model FQDN only) |
| `infra/tests/extractor-isolation.sh` | In-cluster proof: 24 checks |
| `apps/web` | Provenance chips, security explanation panel, provenance graph viewer, plan sandbox (chat), taint violations + trusted contacts (security) |

## Design decisions

- **Two taints per value.** `taint` includes the control-flow context (implicit flow); `dataTaint`
  is data dependencies only. Recipient-class arguments are checked on `dataTaint` with no approval
  path; everything else (the ceiling, approval) uses `taint`. So a literal recipient inside a
  branch on untrusted data needs approval (the *decision* was influenced), while an extracted
  address is refused outright (the *value* was).
- **Branches are block-scoped.** A binding made inside `when` is not visible after it, so a branch
  cannot select which value flows out — the only effects of a branch are its calls and emits.
  Without this, `when evil { let to = a } otherwise { let to = b }` would let content pick among
  trusted recipients without approval.
- **`resolve … in directory|contacts` is the only endorsement.** It looks a key up in a registry
  the tenant controls; the entity's data is TRUSTED, the choice stays as tainted as the key. This
  is the "fix over-tainting with better entity resolution" of §13, not a weakening of propagation.
- **Static inference is exact.** Every propagation rule is data-independent, so the static taint
  of a value equals its runtime taint (except the conservative empty-map case). Provable
  violations are rejected before execution; the soundness suite uses this as an independent
  oracle for the runtime (the AGREEMENT property), which is what caught a planted `coalesce` bug
  the other properties missed.
- **The runtime gate never assumes validation.** `evaluate()` runs without static validation in
  the soundness and red-team suites; the gate still holds. Unknown declarations, forged values
  and nonconforming extractions fail closed as recorded violations.
- **Dry runs read.** In simulate mode R0 reads execute (no side effect) unless the gate requires
  approval (an untrusted URL leaving the org is egress, dry run or not); every effect is simulated.
- **`web.fetch` / `web.search` ceiling is ORG** (module2.md §5.2 said UNTRUSTED; §5.3 of this
  module supersedes it): a URL derived from untrusted content is an exfiltration channel.
- **A tool result cannot vouch for itself.** Provenance envelopes found inside a tool result can
  only raise taint: the result is `join(declared output taint, args, envelopes)`.

## Acceptance criteria (§12)

| Criterion | Status | Proof |
|---|---|---|
| Lattice with all §5.2 rules, property-tested | ✅ | `packages/taint`, `evals/taint-soundness` |
| DSL parses, validates, rejects provable violations before execution | ✅ | `packages/dsl/test` (34 tests); `status: 'invalid'` with no call executed |
| Deterministic — identical traces across 1,000 runs | ✅ | interpreter test (1,000 runs, one trace digest) + DETERMINISM property |
| Every call passes the gate; unresolved provenance fails closed | ✅ | single call site behind `gate()`; PROVENANCE violations for forged values / missing declarations |
| Recipient args reject non-TRUSTED values with no approval path | ✅ | gate table (81 cases); red-team with rubber-stamp approvals: 0 attacker recipients |
| Extractor pod has no tool access and no egress | ✅ | `infra/tests/extractor-isolation.sh` on k3s + Cilium: 24/24 |
| Planner prompts contain no raw untrusted content | ✅ | captured-prompt tests in `packages/planner` and every red-team case |
| `no-untrusted-in-privileged` enforced at build time | ✅ | ESLint config; a planted import produces three INVARIANT 5 errors |
| Red-team: zero successful exfiltrations, blocks the build | ✅ | `evals/redteam` (207 cases, ~6,800 runs), CI job `redteam-injection`; mutation-tested |
| All six soundness properties hold | ✅ | CI job `taint-soundness` (2,000 runs per property); mutation-tested |
| Violations page, persist, visible in the UI | ✅ | `PgRecorder` + `platform_events`, ntfy pager, `/admin/security` |
| Provenance chips and the security panel render in the chat surface | ✅ | plan sandbox on `/chat`; E2E `taint.spec.ts` |

## External items

- **Model key.** Without `ANTHROPIC_API_KEY` (or a LiteLLM gateway key) the extractor runs a
  deterministic development pattern model and says so at startup; production refuses to start.
  The Promptfoo suite measures the live model's hardening once a key is configured.
