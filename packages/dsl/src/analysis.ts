import type { CallExpr, Expr, Program, Stmt } from './ast.js';

/**
 * Static analyses the agent core (Module 4) needs from a program, without running it.
 *
 * `inputDependencies` answers "could this call be influenced by that input?" — data flow AND
 * control flow, the same shape as the taint rules (a call inside a branch depends on whatever
 * the condition depends on). C1's ambiguity policy uses it: an R2/R3 call that depends on an
 * ambiguous binding must wait for a human (docs/module4.md §5.1 rule 3).
 *
 * `callBound` is the worst-case number of tool invocations: a call inside `map`/`filter` runs
 * once per item, up to the collection bound. C2 rejects a program whose bound exceeds the
 * agent's `max_steps` before anything executes (threat T7).
 */

export interface CallDependencies {
  nodeId: string;
  toolId: string;
  /** Inputs (names bound before the program runs) this call's arguments or reachability depend on. */
  inputs: Set<string>;
  /** Other calls whose results flow into this one (data or control). */
  calls: Set<string>;
}

interface Deps {
  inputs: Set<string>;
  calls: Set<string>;
}

const empty = (): Deps => ({ inputs: new Set(), calls: new Set() });
const union = (...ds: Deps[]): Deps => {
  const out = empty();
  for (const d of ds) {
    for (const i of d.inputs) out.inputs.add(i);
    for (const c of d.calls) out.calls.add(c);
  }
  return out;
};

export function inputDependencies(program: Program, inputNames: readonly string[]): CallDependencies[] {
  const result: CallDependencies[] = [];
  const root = new Map<string, Deps>();
  for (const n of inputNames) root.set(n, { inputs: new Set([n]), calls: new Set() });

  const call = (c: CallExpr, scope: Map<string, Deps>, ctx: Deps): Deps => {
    const args = union(ctx, ...c.args.map(([, v]) => expr(v, scope, ctx)));
    result.push({ nodeId: c.id, toolId: c.tool, inputs: args.inputs, calls: args.calls });
    const out = union(args);
    out.calls.add(c.id);
    return out;
  };

  const expr = (e: Expr, scope: Map<string, Deps>, ctx: Deps): Deps => {
    switch (e.k) {
      case 'lit':
        return empty();
      case 'ref':
        return scope.get(e.name) ?? empty();
      case 'select':
      case 'not':
      case 'count':
      case 'extract':
      case 'resolve':
        return expr(e.of, scope, ctx);
      case 'map':
      case 'filter': {
        const of = expr(e.of, scope, ctx);
        // The body runs once per item: whatever decides the collection decides the body's calls.
        const inner = new Map(scope).set(e.as, of);
        return union(of, expr(e.body, inner, union(ctx, of)));
      }
      case 'object':
        return union(...e.fields.map(([, v]) => expr(v, scope, ctx)));
      case 'array':
        return union(...e.items.map((v) => expr(v, scope, ctx)));
      case 'concat':
      case 'coalesce':
        return union(...e.parts.map((v) => expr(v, scope, ctx)));
      case 'compare':
      case 'logic':
        return union(expr(e.left, scope, ctx), expr(e.right, scope, ctx));
      case 'render':
        return expr(e.context, scope, ctx);
      case 'call':
        return call(e, scope, ctx);
    }
  };

  const block = (body: Stmt[], outer: Map<string, Deps>, ctx: Deps): void => {
    const scope = new Map(outer);
    for (const s of body) {
      switch (s.k) {
        case 'let':
          scope.set(s.name, union(ctx, expr(s.value, scope, ctx)));
          break;
        case 'do': {
          const d = call(s.call, scope, ctx);
          if (s.as) scope.set(s.as, d);
          break;
        }
        case 'emit':
          expr(s.value, scope, ctx);
          break;
        case 'when': {
          const inner = union(ctx, expr(s.cond, scope, ctx));
          block(s.then, scope, inner);
          if (s.otherwise) block(s.otherwise, scope, inner);
          break;
        }
      }
    }
  };

  block(program.body, root, empty());
  return result;
}

/** Worst-case tool invocations, with `maxCollection` as the bound of an unlimited map/filter. */
export function callBound(program: Program, maxCollection: number): number {
  const expr = (e: Expr, mult: number): number => {
    switch (e.k) {
      case 'lit':
      case 'ref':
        return 0;
      case 'select':
      case 'not':
      case 'count':
      case 'extract':
      case 'resolve':
        return expr(e.of, mult);
      case 'map':
      case 'filter':
        return expr(e.of, mult) + expr(e.body, mult * Math.min(e.limit ?? maxCollection, maxCollection));
      case 'object':
        return e.fields.reduce((n, [, v]) => n + expr(v, mult), 0);
      case 'array':
        return e.items.reduce((n, v) => n + expr(v, mult), 0);
      case 'concat':
      case 'coalesce':
        return e.parts.reduce((n, v) => n + expr(v, mult), 0);
      case 'compare':
      case 'logic':
        return expr(e.left, mult) + expr(e.right, mult);
      case 'render':
        return expr(e.context, mult);
      case 'call':
        return mult + e.args.reduce((n, [, v]) => n + expr(v, mult), 0);
    }
  };
  const block = (body: Stmt[]): number =>
    body.reduce((n, s) => {
      switch (s.k) {
        case 'let':
          return n + expr(s.value, 1);
        case 'do':
          return n + expr(s.call, 1);
        case 'emit':
          return n + expr(s.value, 1);
        case 'when':
          // Both branches count: the bound must hold whichever way the condition goes.
          return n + expr(s.cond, 1) + Math.max(block(s.then), block(s.otherwise ?? []));
      }
    }, 0);
  return block(program.body);
}

/**
 * C1's ambiguity policy with the plan in hand (docs/module4.md §5.1 rule 3): an ambiguous input
 * that any R2/R3 call depends on — data or control — BLOCKS; one only R0/R1 calls depend on
 * proceeds on the best guess, recorded as an assumption. A call to a tool of unknown
 * reversibility counts as irreversible.
 */
export function ambiguityPolicy(
  program: Program,
  inputNames: readonly string[],
  ambiguous: readonly string[],
  reversibility: (toolId: string) => string | undefined,
): { blocking: string[]; assumptions: Array<{ binding: string; toolId: string; reversibility: string }> } {
  const deps = inputDependencies(program, inputNames);
  const blocking: string[] = [];
  const assumptions: Array<{ binding: string; toolId: string; reversibility: string }> = [];
  for (const b of ambiguous) {
    const users = deps.filter((d) => d.inputs.has(b));
    if (users.some((d) => ['R2', 'R3'].includes(reversibility(d.toolId) ?? 'R3'))) blocking.push(b);
    else for (const u of users) assumptions.push({ binding: b, toolId: u.toolId, reversibility: reversibility(u.toolId) ?? 'R3' });
  }
  return { blocking, assumptions };
}
