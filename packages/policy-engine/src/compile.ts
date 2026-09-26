import { createHash } from 'node:crypto';
import type { Condition, Policy, Predicate, Scalar } from './schema.js';
import { toMatch } from './evaluate.js';

/**
 * YAML AST → REGO (docs/module5.md §5.1). Deterministic: the same policies and versions produce
 * byte-identical modules (golden files), so a reviewer can read the source and the output side by
 * side and a bundle digest identifies its contents.
 *
 * Each policy becomes one `matches contains {…} if {…}` rule in the package. `any` and `not`
 * compile to helper rules named after the policy and a hash of the sub-condition, so nothing
 * depends on generation order. Semantics match the reference evaluator exactly:
 *   · an absent field fails the body (except `exists: false`, compiled through `object.get`)
 *   · comparisons are type-guarded (`is_number`), lists are guarded (`is_array`)
 */

export function packageFor(scope: { kind: 'tenant'; tenantId: string } | { kind: 'preset'; name: string } | { kind: 'custom'; path: string }): string {
  if (scope.kind === 'tenant') return `vega.t_${scope.tenantId.replace(/-/g, '')}`;
  if (scope.kind === 'preset') return `vega.presets.${scope.name}`;
  return scope.path;
}

const lit = (v: Scalar) => JSON.stringify(v);
const ref = (field: string) => `input.${field}`;
const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 10);
const ident = (id: string) => id.replace(/-/g, '_');

class Compiler {
  private readonly helpers: string[] = [];
  private readonly seen = new Set<string>();
  private vars = 0;

  constructor(private readonly policyId: string) {}

  /** Body lines that hold iff the predicate holds. */
  private leaf(field: string, p: Predicate): string[] {
    const x = ref(field);
    switch (p.op) {
      case 'eq':
        return [`${x} == ${lit(p.value)}`];
      case 'not':
        return [`${x} != null`, `${x} != ${lit(p.value)}`];
      case 'in':
        return [`${x} in {${p.values.map(lit).join(', ')}}`];
      case 'not_in': {
        const v = `v${++this.vars}`;
        return [`${v} := ${x}`, `${v} != null`, `not ${v} in {${p.values.map(lit).join(', ')}}`];
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        return [`is_number(${x})`, `${x} ${{ gt: '>', gte: '>=', lt: '<', lte: '<=' }[p.op]} ${p.value}`];
      case 'contains':
        return [`is_array(${x})`, `${lit(p.value)} in ${x}`];
      case 'exists': {
        // `object.get` with a null default: absent and null are the same answer on both sides
        // (a bare `not input.a.b != null` would be undefined — not true — when `a` is missing).
        const got = `object.get(input, ${JSON.stringify(field.split('.'))}, null)`;
        return [`${got} ${p.value ? '!=' : '=='} null`];
      }
    }
  }

  /** A helper rule that holds iff `c` does; returns its name. Identical sub-conditions share one. */
  private helper(c: Condition): string {
    const key = JSON.stringify(c);
    const name = `c_${ident(this.policyId)}_${short(key)}`;
    if (this.seen.has(key)) return name;
    this.seen.add(key);
    if ('any' in c) {
      for (const branch of c.any) this.helpers.push(`${name} if {\n${this.body(branch).map((l) => `\t${l}`).join('\n')}\n}`);
    } else {
      this.helpers.push(`${name} if {\n${this.body(c).map((l) => `\t${l}`).join('\n')}\n}`);
    }
    return name;
  }

  body(c: Condition): string[] {
    if ('all' in c) return c.all.flatMap((x) => this.body(x));
    if ('any' in c) return [this.helper(c)];
    if ('not' in c) return [`not ${this.helper(c.not)}`];
    return this.leaf(c.field, c.pred);
  }

  rules(): string[] {
    return this.helpers;
  }
}

/** One policy → its rule(s), as Rego source. */
export function compilePolicy(p: Policy, version: number): string {
  const c = new Compiler(p.id);
  const body = c.body(p.when);
  const m = toMatch(p, version);
  // Keys in a fixed order: the object literal is part of the golden output.
  const obj = `{${(Object.keys(m) as Array<keyof typeof m>)
    .sort()
    .map((k) => `${JSON.stringify(k)}: ${JSON.stringify(m[k])}`)
    .join(', ')}}`;
  const header = `# ${p.id} v${version}${p.citation ? ` — ${p.citation}` : ''}\n# ${p.description.replace(/\n/g, ' ')}`;
  const rule = `matches contains ${obj} if {\n${body.map((l) => `\t${l}`).join('\n')}\n}`;
  return [header, rule, ...c.rules()].join('\n\n');
}

/** A complete module: package, import, and every policy (sorted by id). */
export function compileModule(pkg: string, policies: ReadonlyArray<{ policy: Policy; version: number }>): string {
  const sorted = [...policies].sort((a, b) => a.policy.id.localeCompare(b.policy.id));
  const parts = [
    `# GENERATED from YAML policies by @vega/policy-engine — never edit by hand.`,
    `package ${pkg}`,
    // A partial set: nothing matching evaluates to the empty set — "no policy matched" is an answer.
    `import rego.v1`,
    ...sorted.map((p) => compilePolicy(p.policy, p.version)),
  ];
  return `${parts.join('\n\n')}\n`;
}
