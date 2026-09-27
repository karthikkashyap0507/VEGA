# evals/compensation

M6 — compensator correctness against the sandbox providers (docs/module6.md §11.1): capture, execute,
compensate, compare with the snapshot, compensate again (no additional effect). `pnpm --filter
@vega/eval-compensation eval` writes `report/`. Blocking in CI via `test/harness.test.ts`.
