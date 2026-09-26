import type { ToolDeclarationRecord } from '@vega/contracts';
import { gt, join, type Taint } from '@vega/taint';
import { ProgramSchema, type CallExpr, type Expr, type Program, type Stmt } from './ast.js';

/**
 * STATIC VALIDATION — docs/module3.md §6.3, before any execution:
 *   1. every tool id resolves    2. argument shapes check    3. extract schemas exist
 *   4. collection bounds         5. static taint inference rejects PROVABLE gate violations
 *   6. no unreachable branches, no unused reads, no calls nested in call arguments
 *
 * Static inference runs the SAME propagation rules as the interpreter, over the declared taints
 * (a read's declared output taint, never its content). Because no rule depends on data, the
 * static taint of a value is exactly its runtime taint, with one conservative exception: a map
 * over an empty collection is statically as tainted as its body. So a static violation is a
 * violation on every execution, and the planner gets it back before anything runs.
 */

export interface ValidationEnv {
  tool(toolId: string): ToolDeclarationRecord | undefined;
  hasSchema(name: string): boolean;
  hasTemplate(name: string): boolean;
  /** Static bound on map/filter (docs/module3.md §6.2: default 100). */
  maxCollection?: number;
  /** Taint of names bound before the program runs (e.g. `objective` = TRUSTED). */
  inputs?: Record<string, { taint: Taint; dataTaint: Taint }>;
}

export type ValidationCode =
  | 'SCHEMA'
  | 'UNKNOWN_TOOL'
  | 'UNKNOWN_ARG'
  | 'MISSING_ARG'
  | 'ARG_TYPE'
  | 'UNKNOWN_SCHEMA'
  | 'UNKNOWN_TEMPLATE'
  | 'UNKNOWN_REF'
  | 'DUPLICATE_BINDING'
  | 'DUPLICATE_NODE_ID'
  | 'BOUND_EXCEEDED'
  | 'NESTED_CALL'
  | 'UNREACHABLE'
  | 'UNUSED_READ'
  | 'TAINT_RECIPIENT'
  | 'TAINT_CEILING';

export interface ValidationIssue {
  code: ValidationCode;
  message: string;
  nodeId?: string;
  path?: string;
  severity?: 'HIGH' | 'CRITICAL';
}

export interface StaticCall {
  nodeId: string;
  toolId: string;
  /** join of every argument leaf and the control context. */
  argTaint: Taint;
  /** Control-flow context the call runs in. */
  contextTaint: Taint;
  /** Recipient-class leaves and their data taint. */
  recipients: Array<{ path: string; dataTaint: Taint }>;
  /** What the gate will do, statically. */
  expected: 'PROCEED' | 'REQUIRE_APPROVAL' | 'VIOLATION';
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  calls: StaticCall[];
}

interface Sym {
  taint: Taint;
  dataTaint: Taint;
  /** Set for a read's result until something uses it (UNUSED_READ). */
  readCall?: string;
}

const LIT: Sym = { taint: 'TRUSTED', dataTaint: 'TRUSTED' };
const both = (...xs: Sym[]): Sym => ({ taint: join(...xs.map((x) => x.taint)), dataTaint: join(...xs.map((x) => x.dataTaint)) });
const inCtx = (s: Sym, ctx: Taint): Sym => ({ taint: join(s.taint, ctx), dataTaint: s.dataTaint });

/** Flattens call arguments to leaves: object literals by key, array literals by index. */
export function argLeaves(args: Array<[string, Expr]>, prefix = ''): Array<{ path: string; expr: Expr }> {
  const out: Array<{ path: string; expr: Expr }> = [];
  for (const [k, v] of args) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v.k === 'object') out.push(...argLeaves(v.fields, path));
    else if (v.k === 'array' && v.items.length) v.items.forEach((item, i) => out.push(...(item.k === 'object' ? argLeaves(item.fields, `${path}[${i}]`) : [{ path: `${path}[${i}]`, expr: item }])));
    else out.push({ path, expr: v });
  }
  return out;
}

/** Does leaf `path` fall under declared recipient argument `r` (e.g. to, to[0], patch.attendees[1])? */
export function underRecipient(path: string, r: string): boolean {
  return path === r || path.startsWith(`${r}.`) || path.startsWith(`${r}[`);
}

function jsonType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(schema: Record<string, unknown> | undefined, value: unknown): boolean {
  if (!schema) return true;
  const types = schema['type'] === undefined ? undefined : Array.isArray(schema['type']) ? (schema['type'] as string[]) : [schema['type'] as string];
  if (!types) return true;
  const t = jsonType(value);
  return types.includes(t) || (t === 'integer' && types.includes('number'));
}

export function validate(program: unknown, env: ValidationEnv): ValidationResult {
  const parsed = ProgramSchema.safeParse(program);
  if (!parsed.success) {
    return { valid: false, errors: parsed.error.issues.slice(0, 20).map((i) => ({ code: 'SCHEMA' as const, message: `${i.path.join('.')}: ${i.message}` })), calls: [] };
  }
  const prog = parsed.data as Program;
  const errors: ValidationIssue[] = [];
  const calls: StaticCall[] = [];
  const bound = env.maxCollection ?? 100;
  const nodeIds = new Set<string>();
  const unused = new Map<string, CallExpr>();

  const checkId = (id: string) => {
    if (nodeIds.has(id)) errors.push({ code: 'DUPLICATE_NODE_ID', message: `node id ${id} appears twice`, nodeId: id });
    nodeIds.add(id);
  };

  const evalExpr = (e: Expr, scope: Map<string, Sym>, ctx: Taint, allowCall: boolean): Sym => {
    switch (e.k) {
      case 'lit':
        return inCtx(LIT, ctx);
      case 'ref': {
        const s = scope.get(e.name);
        if (!s) {
          errors.push({ code: 'UNKNOWN_REF', message: `"${e.name}" is not bound here` });
          return { taint: 'UNTRUSTED', dataTaint: 'UNTRUSTED' };
        }
        if (s.readCall) unused.delete(s.readCall);
        return inCtx(s, ctx);
      }
      case 'select':
      case 'extract':
        if (e.k === 'extract' && !env.hasSchema(e.schema)) errors.push({ code: 'UNKNOWN_SCHEMA', message: `no extraction schema "${e.schema}"` });
        return inCtx(evalExpr(e.of, scope, ctx, allowCall), ctx);
      case 'resolve': {
        const key = evalExpr(e.of, scope, ctx, allowCall);
        // Endorsement: registry data is TRUSTED; the choice stays as tainted as the key.
        return { taint: join(key.taint, ctx), dataTaint: 'TRUSTED' };
      }
      case 'object':
        return inCtx(both(LIT, ...e.fields.map(([, v]) => evalExpr(v, scope, ctx, allowCall))), ctx);
      case 'array':
        return inCtx(both(LIT, ...e.items.map((v) => evalExpr(v, scope, ctx, allowCall))), ctx);
      case 'map':
      case 'filter': {
        if ((e.limit ?? bound) > bound) errors.push({ code: 'BOUND_EXCEEDED', message: `${e.k} limit ${e.limit} exceeds ${bound}` });
        const coll = evalExpr(e.of, scope, ctx, allowCall);
        if (scope.has(e.as)) errors.push({ code: 'DUPLICATE_BINDING', message: `"${e.as}" is already bound` });
        const inner = new Map(scope).set(e.as, coll);
        const body = evalExpr(e.body, inner, ctx, allowCall);
        return inCtx(both(coll, body), ctx);
      }
      case 'concat':
      case 'coalesce':
        return inCtx(both(...e.parts.map((p) => evalExpr(p, scope, ctx, allowCall))), ctx);
      case 'compare':
      case 'logic':
        return inCtx(both(evalExpr(e.left, scope, ctx, allowCall), evalExpr(e.right, scope, ctx, allowCall)), ctx);
      case 'not':
      case 'count':
        return inCtx(evalExpr(e.of, scope, ctx, allowCall), ctx);
      case 'render':
        if (!env.hasTemplate(e.template)) errors.push({ code: 'UNKNOWN_TEMPLATE', message: `no template "${e.template}"` });
        return inCtx(evalExpr(e.context, scope, ctx, allowCall), ctx);
      case 'call':
        return evalCall(e, scope, ctx, allowCall);
    }
  };

  const evalCall = (c: CallExpr, scope: Map<string, Sym>, ctx: Taint, allowCall: boolean): Sym => {
    checkId(c.id);
    if (!allowCall) errors.push({ code: 'NESTED_CALL', message: 'a call cannot appear inside call arguments or a branch condition; bind it with let first', nodeId: c.id });
    const decl = env.tool(c.tool);
    const leaves = argLeaves(c.args);
    const leafSyms = leaves.map((l) => ({ ...l, sym: evalExpr(l.expr, scope, ctx, false) }));
    if (!decl) {
      errors.push({ code: 'UNKNOWN_TOOL', message: `no tool "${c.tool}"`, nodeId: c.id });
      return { taint: 'UNTRUSTED', dataTaint: 'UNTRUSTED' };
    }
    // ---------------------------------------------------------------- shape
    const schema = decl.argsSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
    const props = schema.properties ?? {};
    for (const [name, v] of c.args) {
      if (!(name in props)) errors.push({ code: 'UNKNOWN_ARG', message: `${c.tool} has no argument "${name}"`, nodeId: c.id, path: name });
      else if (v.k === 'lit' && !typeMatches(props[name], v.value)) errors.push({ code: 'ARG_TYPE', message: `${c.tool}.${name} does not accept ${jsonType(v.value)}`, nodeId: c.id, path: name });
    }
    for (const r of schema.required ?? []) {
      if (!c.args.some(([n]) => n === r) && !('default' in (props[r] ?? {}))) {
        errors.push({ code: 'MISSING_ARG', message: `${c.tool} requires "${r}"`, nodeId: c.id, path: r });
      }
    }
    // ---------------------------------------------------------------- taint (the gate, statically)
    const recipients = leafSyms.filter((l) => decl.recipientArgs.some((r) => underRecipient(l.path, r))).map((l) => ({ path: l.path, dataTaint: l.sym.dataTaint }));
    const argTaint = join(ctx, ...leafSyms.map((l) => l.sym.taint));
    let expected: StaticCall['expected'] = 'PROCEED';
    for (const r of recipients) {
      if (r.dataTaint !== 'TRUSTED') {
        expected = 'VIOLATION';
        errors.push({
          code: 'TAINT_RECIPIENT',
          severity: 'CRITICAL',
          message: `${c.tool}.${r.path} is a recipient and would be ${r.dataTaint}-derived; recipients must be TRUSTED (use a literal the principal gave, or resolve in directory/contacts)`,
          nodeId: c.id,
          path: r.path,
        });
      }
    }
    if (expected !== 'VIOLATION' && gt(argTaint, decl.maxTaint)) {
      if (decl.egressClass === 'INTERNAL') {
        expected = 'VIOLATION';
        errors.push({ code: 'TAINT_CEILING', severity: 'HIGH', message: `${c.tool} accepts at most ${decl.maxTaint}; these arguments are ${argTaint}`, nodeId: c.id, path: 'args' });
      } else {
        expected = 'REQUIRE_APPROVAL';
      }
    }
    calls.push({ nodeId: c.id, toolId: c.tool, argTaint, contextTaint: ctx, recipients, expected });
    const out: Sym = { taint: join(decl.outputTaint, argTaint), dataTaint: join(decl.outputTaint, ...leafSyms.map((l) => l.sym.dataTaint)) };
    // A read consumed inline (a map body, an emit) is used; one bound to a name is used when
    // the name is referenced. Only bindings register as possibly-unused.
    if (decl.reversibility === 'R0') out.readCall = c.id;
    return out;
  };

  const block = (body: Stmt[], outer: Map<string, Sym>, ctx: Taint) => {
    // Bindings made in a block are visible in that block only: a branch can influence which
    // calls happen, never which value flows out of it.
    const scope = new Map(outer);
    for (const s of body) {
      switch (s.k) {
        case 'let': {
          if (scope.has(s.name)) errors.push({ code: 'DUPLICATE_BINDING', message: `"${s.name}" is already bound` });
          const sym = evalExpr(s.value, scope, ctx, true);
          if (s.value.k === 'call' && sym.readCall) unused.set(sym.readCall, s.value);
          scope.set(s.name, s.value.k === 'call' ? sym : { taint: sym.taint, dataTaint: sym.dataTaint });
          break;
        }
        case 'do': {
          const sym = evalCall(s.call, scope, ctx, true);
          if (s.as) {
            if (scope.has(s.as)) errors.push({ code: 'DUPLICATE_BINDING', message: `"${s.as}" is already bound` });
            if (sym.readCall) unused.set(sym.readCall, s.call);
            scope.set(s.as, sym);
          } else if (sym.readCall) {
            // A read whose result is dropped on the spot is always unused.
            errors.push({ code: 'UNUSED_READ', message: `${s.call.tool} is a read whose result is never used`, nodeId: s.call.id });
          }
          break;
        }
        case 'emit':
          evalExpr(s.value, scope, ctx, true);
          break;
        case 'when': {
          checkId(s.id);
          if (s.cond.k === 'lit') {
            errors.push({ code: 'UNREACHABLE', message: `branch condition is the constant ${JSON.stringify(s.cond.value)}`, nodeId: s.id });
          }
          const cond = evalExpr(s.cond, scope, ctx, false);
          const inner = join(ctx, cond.taint);
          block(s.then, scope, inner);
          if (s.otherwise) block(s.otherwise, scope, inner);
          break;
        }
      }
    }
  };

  const top = new Map<string, Sym>(Object.entries(env.inputs ?? {}).map(([k, v]) => [k, { ...v }]));
  block(prog.body, top, 'TRUSTED');
  for (const c of unused.values()) errors.push({ code: 'UNUSED_READ', message: `${c.tool} is a read whose result is never used`, nodeId: c.id });
  return { valid: errors.length === 0, errors, calls };
}
