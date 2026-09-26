/**
 * @vega/eslint-rules — the architectural invariants of PROJECT.md §10.2 as build errors
 * (module1.md §5.6, TECHSTACK §4). These are not style rules: a failure means the
 * architecture has drifted.
 *
 * `require-tool-declaration` (M2) and `no-untrusted-in-privileged` (M3) ship now as
 * configured-but-inert rules, so those modules ENABLE them rather than INTRODUCE them.
 */
import noEval from './rules/no-eval.js';
import noEvidenceWriteFromExecution from './rules/no-evidence-write-from-execution.js';
import noPlanBranching from './rules/no-plan-branching.js';
import noRawDbPool from './rules/no-raw-db-pool.js';
import noTaintCast from './rules/no-taint-cast.js';
import noUntrustedInPrivileged from './rules/no-untrusted-in-privileged.js';
import requireTenantContext from './rules/require-tenant-context.js';
import requireToolDeclaration from './rules/require-tool-declaration.js';

export const rules = {
  'no-evidence-write-from-execution': noEvidenceWriteFromExecution,
  'no-raw-db-pool': noRawDbPool,
  'no-eval': noEval,
  'require-tenant-context': requireTenantContext,
  'no-untrusted-in-privileged': noUntrustedInPrivileged,
  'require-tool-declaration': requireToolDeclaration,
  'no-plan-branching': noPlanBranching,
  'no-taint-cast': noTaintCast,
};

const plugin = { meta: { name: '@vega/eslint-rules', version: '0.0.0' }, rules };
export default plugin;
