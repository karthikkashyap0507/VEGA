import type { Rule } from 'eslint';

/**
 * Types for the plugin, which is plain JavaScript so eslint.config.mjs can load it without a
 * build step. Keep the names in step with `rules` in index.js — the fixture tests index by them.
 */
type RuleName =
  | 'no-evidence-write-from-execution'
  | 'no-raw-db-pool'
  | 'no-eval'
  | 'require-tenant-context'
  | 'no-untrusted-in-privileged'
  | 'require-tool-declaration'
  | 'no-plan-branching'
  | 'no-taint-cast';

export declare const rules: Record<RuleName, Rule.RuleModule>;

declare const plugin: { meta: { name: string; version: string }; rules: typeof rules };
export default plugin;
