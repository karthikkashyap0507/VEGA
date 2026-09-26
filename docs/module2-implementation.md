# Module 2 — Implementation Record

> What was built for [module2.md](module2.md), where it lives, and how each acceptance criterion
> is proven. Items that need external accounts are marked **external** with the exact next step.

---

## Layout

| Path | What |
|---|---|
| `packages/contracts/src/tools.ts` | Frozen `ToolDeclaration` contract: enums, `Effect`, `Sourced`, `ToolResult`, `ToolDeclarationRecord`, type-level `CompensatorRequirement` |
| `packages/contracts/src/connectors.ts` | Connector / tool / MCP API contracts |
| `packages/connectors/sdk` | `defineTool` (+ `defineRuntimeTool` for MCP), registry, OAuth (PKCE, minimal scopes, forbidden scopes), consent model, commit-aware retry, token buckets (memory + Valkey Lua), idempotency ledger, single-flight refresh, `ConnectorRuntime`, Postgres + memory stores |
| `packages/connectors/{gmail,gcal,gdrive,outlook,sharepoint,slack,web,http}` | The eight launch connectors (§5.2 table) |
| `packages/connectors/mcp` | MCP client: discovery over Streamable HTTP, conservative defaults, admin declarations, dynamic tool source |
| `packages/connectors/testing` | In-process provider fakes (Google, Graph, Slack) behind the production `fetch` seam |
| `packages/connectors/registry` | `@vega/connectors`: launch set, env OAuth clients, `tool_declarations` projection generator |
| `packages/db/migrations/0004_connectors.sql`, `0005_mcp_tools.sql` | §4 tables, forced RLS, compensator CHECKs, one MCP slug per tenant |
| `packages/db/reference/tool_declarations.sql` | Generated projection (`pnpm tools:generate`), re-applied by the migrator |
| `services/control/src/routers/{connectors,tools,mcp}.ts` | Connector CRUD, OAuth broker, consent, tools, MCP |
| `services/execution/src/connectors.ts` | Internal API: simulate / execute / health / MCP discovery |
| `services/gateway/src/routes/connectors.ts` | Public `/v1` surface — **no execute route** |
| `services/web-fetch` | Isolated fetcher: no secrets, no SA token, public-only egress |
| `infra/helm/platform` | web-fetch workload + Cilium policy; provider FQDN egress for control/execution |
| `infra/tests/web-fetch-isolation.sh` | In-cluster SSRF proof (raw sockets from the pod) |
| `evals/simulation` | Simulation accuracy harness (reused by M6 for compensators) |
| `.semgrep/tokens.yml` | Token-leak rules + fixture |
| `.github/PULL_REQUEST_TEMPLATE/connector.md` | Certification checklist (§12) |
| `apps/web/src/app/(app)/admin/connectors/**` | Gallery, consent screen, tool inspector, health |

## Decisions worth knowing

- **OAuth callback is per provider** (`/v1/oauth/{google,microsoft,slack}/callback`): one redirect
  URI per OAuth app, whichever connector kinds share it. The state is AES-GCM sealed and binds
  connector, tenant, user and PKCE verifier; the callback is authenticated by the caller's own
  session and must match the tenant **and** user that started it.
- **Plane split for connectors:** control holds OAuth client secrets, does code exchange and
  revocation (FQDN egress to token endpoints only). Everything that uses a tenant credential
  against a provider data API — simulate, health, MCP discovery, execute — runs in execution.
- **`tool_declarations` is reference data, not a migration:** generated from the registry and
  upserted on every migrate. Old versions stay (evidence references them). Drift fails
  `declarations-db.test.ts`.
- **MCP:** undeclared tools are `EXTERNAL/R3/TRUSTED/NONE`, held, output `UNTRUSTED`, autonomy
  capped at `SUPERVISED`. Server annotations (`readOnlyHint` …) and server-published declarations
  never apply automatically; an admin adopts or authors a declaration, validated by the same
  rules as code declarations (compensator must be a tool on the same server).
- **Simulation convention:** ids a provider assigns at execution are written `(new …)` in a
  simulation. The harness found and fixed four real prediction errors (gcal conflicts on execute,
  gcal.update predicting the pre-change event, gdrive.share ignoring existing access — which would
  have made M6 revoke access the person already had — and slack.post record ids).

## Acceptance criteria (§13)

| Criterion | Status | Proof |
|---|---|---|
| `require-tool-declaration` enforced; a tool without one fails the build | ✅ | ESLint rule (contract field names + conditional compensator) with fixtures; type-level `CompensatorRequirement`; DB CHECK `compensator_required` (test inserts as owner and is refused) |
| All 8 launch connectors authorize, execute, refresh, revoke | ✅ fakes · **external** live | Contract suite (46 tests) + cross-plane control tests with real Postgres/OpenFGA. Live: provision sandbox tenants (§11.1), set `CONNECTOR_SANDBOX=live` |
| Every launch tool implements `simulate()`; fidelity honest | ✅ | Harness covers all 25 tools; every DERIVED tool 100%; `http.request` is DECLARED and reported, not held |
| Consent screen generated from declarations, matches granted scopes | ✅ | `consentModel()`; E2E asserts the Google redirect carries exactly the consented scopes + `openid email`, PKCE S256, no full-mailbox scope |
| Double invocation with same key → one effect | ✅ | Contract tests (memory) + `PgInvocationStore` test (Postgres) |
| Web-fetch pod cannot reach metadata or private ranges | ✅ | `infra/tests/web-fetch-isolation.sh` on k3s + Cilium: 29 checks pass; removing the policy's exclusions makes 5 fail |
| No token material in logs, traces, errors | ✅ | `redact()` + contract test; Semgrep rules (4/4 fixture findings, 0 in repo); tokens sealed in `secret_refs` (test reads ciphertext) |
| MCP server attached and tools registered with declarations | ✅ | `mcp.test.ts` (real MCP SDK server in-process), control tests attach → discover → adopt |
| Health dashboard reflects real provider state | ✅ | Probe via execution, events, ledger stats (success rate, p50/p99), `/admin/connectors/:id/health` |
| Simulation harness nightly, per-tool report | ✅ | `.github/workflows/nightly.yml`; `pnpm --filter @vega/eval-simulation eval` writes `report.{json,md}` |

## External items (cannot be done from a repository)

- **Google + Microsoft OAuth app verification** (§15, §14): submit in week 1 — Google Cloud
  console → OAuth consent screen → Publish → verification for restricted Gmail/Drive scopes
  (security assessment required); Microsoft Entra publisher verification. Redirect URIs:
  `https://<gateway>/v1/oauth/google/callback`, `…/microsoft/callback`, `…/slack/callback`.
- **Sandbox tenants** (§11.1): a Google Workspace test domain and a Microsoft 365 developer
  tenant; wire their grants into a `live` sandbox for `evals/simulation` and the contract suite.
- **Certification** (`certified_at`): set per declaration when the §12 PR template is complete.
