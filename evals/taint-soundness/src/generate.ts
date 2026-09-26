import type { ToolDeclarationRecord } from '@vega/contracts';
import type { CallExpr, Expr, Program, Stmt } from '@vega/dsl';
import type { Taint } from '@vega/taint';

/**
 * Random, scope-correct programs for the soundness suite (docs/module3.md §11.2). A seeded PRNG
 * drives a builder that only references names in scope, so every generated program is
 * well-formed and exercises real data flow; fast-check supplies seeds and shrinks sizes.
 *
 * The tool set is synthetic on purpose: every combination of egress class, ceiling, output taint
 * and recipient marking appears, so a gate bug cannot hide behind the launch connectors' choices.
 */

export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}
export type Rng = ReturnType<typeof rng>;

const LEVELS: Taint[] = ['TRUSTED', 'ORG', 'UNTRUSTED'];

export function syntheticTools(): ToolDeclarationRecord[] {
  const out: ToolDeclarationRecord[] = [];
  for (const egress of ['INTERNAL', 'EXTERNAL', 'PUBLIC'] as const) {
    for (const max of LEVELS) {
      for (const output of LEVELS) {
        const id = `syn.${egress.toLowerCase()}_${max.toLowerCase()}_${output.toLowerCase()}`;
        out.push({
          toolId: id,
          connectorKind: 'http',
          version: 1,
          title: id,
          description: id,
          scopes: [],
          egressClass: egress,
          reversibility: egress === 'INTERNAL' ? 'R0' : 'R3',
          maxTaint: max,
          idempotency: 'NONE',
          sensitivityHint: 0,
          holdSupported: false,
          simulateFidelity: 'DECLARED',
          compensatorRef: null,
          outputTaint: output,
          recipientArgs: egress === 'INTERNAL' ? [] : ['to'],
          argsSchema: { type: 'object', properties: { to: {}, body: {}, n: {} } },
          effectSchema: { type: 'object' },
          costHint: null,
        });
      }
    }
  }
  return out;
}

export interface Generated {
  program: Program;
  inputs: Record<string, { data: unknown; taint: Taint }>;
}

export function generate(seed: number, size: number, inputTaints: Taint[]): Generated {
  const r = rng(seed);
  const tools = syntheticTools();
  const inputs: Generated['inputs'] = {};
  const names: string[] = [];
  inputTaints.forEach((t, i) => {
    const name = `in${i}`;
    inputs[name] = { data: r.pick(['alice@acme.example', 'x@evil.example', 'hello', 3, true, ['a', 'b'], { k: 'v', list: [1, 2] }]), taint: t };
    names.push(name);
  });
  let node = 0;
  let bind = 0;
  const nid = () => `n${++node}`;

  const expr = (scope: string[], depth: number): Expr => {
    const leaf = (): Expr => (scope.length && r.chance(0.7) ? { k: 'ref', name: r.pick(scope) } : { k: 'lit', value: r.pick(['s', 1, true, null, 'bob@acme.example']) });
    if (depth <= 0) return leaf();
    const d = depth - 1;
    switch (r.int(12)) {
      case 0:
        return { k: 'select', of: expr(scope, d), path: [r.pick(['k', 'list', 0, 1, 'x'])] };
      case 1:
        return { k: 'object', fields: [['a', expr(scope, d)], ['b', expr(scope, d)]] };
      case 2:
        return { k: 'array', items: [expr(scope, d), expr(scope, d)] };
      case 3: {
        const as = `e${++bind}`;
        return { k: r.chance(0.5) ? 'map' : 'filter', of: { k: 'array', items: [expr(scope, d), expr(scope, d)] }, as, body: expr([...scope, as], d), limit: 10 };
      }
      case 4:
        return { k: 'compare', op: r.pick(['==', '!=', '<', '>'] as const), left: expr(scope, d), right: expr(scope, d) };
      case 5:
        return { k: 'logic', op: r.pick(['and', 'or'] as const), left: expr(scope, d), right: expr(scope, d) };
      case 6:
        return { k: 'not', of: expr(scope, d) };
      case 7:
        return { k: 'count', of: expr(scope, d) };
      case 8:
        return { k: 'coalesce', parts: [expr(scope, d), expr(scope, d)] };
      case 9:
        return { k: 'render', template: 'plain', context: expr(scope, d) };
      case 10:
        return { k: 'resolve', of: expr(scope, d), registry: r.pick(['directory', 'contacts'] as const) };
      default:
        return { k: 'extract', of: expr(scope, d), schema: 'Blob' };
    }
  };

  const call = (scope: string[]): CallExpr => {
    const tool = r.pick(tools);
    const args: Array<[string, Expr]> = [['body', expr(scope, 2)]];
    if (tool.recipientArgs.length) args.push(['to', { k: 'array', items: [expr(scope, 1)] }]);
    if (r.chance(0.3)) args.push(['n', expr(scope, 1)]);
    return { k: 'call', id: nid(), tool: tool.toolId, args };
  };

  const block = (scope: string[], n: number, depth: number): Stmt[] => {
    const out: Stmt[] = [];
    const local = [...scope];
    for (let i = 0; i < n; i++) {
      const pickStmt = r.int(depth > 0 ? 5 : 4);
      if (pickStmt === 0) {
        const name = `x${++bind}`;
        out.push({ k: 'let', name, value: expr(local, 3) });
        local.push(name);
      } else if (pickStmt === 1) {
        const name = `c${++bind}`;
        out.push({ k: 'do', call: call(local), as: name });
        local.push(name);
      } else if (pickStmt === 2) {
        out.push({ k: 'do', call: call(local) });
      } else if (pickStmt === 3) {
        out.push({ k: 'emit', value: expr(local, 2) });
      } else {
        const id = nid();
        out.push({ k: 'when', id, cond: expr(local, 2), then: block(local, 2, depth - 1), otherwise: block(local, 1, depth - 1) });
      }
    }
    return out;
  };

  return { program: { version: 1, body: block(names, Math.max(1, size), 2) }, inputs };
}
