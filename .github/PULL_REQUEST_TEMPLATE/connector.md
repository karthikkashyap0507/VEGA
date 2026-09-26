<!--
  Connector certification — docs/module2.md §12. Use this template for a NEW connector or a
  new tool on an existing one:  ?template=connector.md
  No connector reaches production without every box ticked. On merge, the release process
  sets tool_declarations.certified_at for the declarations in this PR.
-->

## Connector

- Kind / tools:
- Provider API docs used:
- Measured effort (hours, connector #N — PROJECT.md §24 economics):

## Certification checklist

- [ ] Declaration complete and typechecks for every exported tool (`defineTool({...})`, lint rule `require-tool-declaration` green)
- [ ] Scopes minimized and **justified per tool** (list each scope and why no narrower one works; unavoidable broad scopes are shown on the consent screen)
- [ ] `simulate()` implemented; fidelity (`PROVIDER` / `DERIVED` / `DECLARED`) honestly declared
- [ ] Simulation accuracy ≥ 99% on the harness (`pnpm --filter @vega/eval-simulation eval`; paste the table row)
- [ ] Compensator registered and tested for every `R1`/`R2` action *(completed in Module 6)*
- [ ] Taint classification (`maxTaint`, `outputTaint`, `recipientArgs`) reviewed by a second engineer: @
- [ ] Idempotency verified by the double-invocation contract test
- [ ] Rate limits sourced from provider documentation, not guessed (link):
- [ ] Error normalization covers the provider's documented error set (401/403/404/409/429/5xx and provider-specific)
- [ ] Health probe implemented
- [ ] Token refresh and revocation tested end to end (contract suite + OAuth round-trip)
- [ ] No secret appears in any log, trace, or error path (Semgrep `.semgrep/tokens.yml` green; redaction test)
- [ ] `pnpm tools:generate` run and `packages/db/reference/tool_declarations.sql` committed

## Evidence

<!-- Contract test output, harness report row, and anything a reviewer should look at. -->
