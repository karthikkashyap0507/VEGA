import { createHash } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type { ToolDeclarationRecord } from '@vega/contracts';
import { argLeaves, callsOf, validate, type CallExpr, type Expr, type Program, type Stmt, type ValidationIssue } from '@vega/dsl';
import { canonicalJson, derive, digestOf, endorse, fromSource, isTainted, join, literal, type Taint, type TaintedValue } from '@vega/taint';
import { gate, type GateDecision } from './gate.js';
import type { DeclarationPort, EntityPort, ExtractorPort, Pager, PolicyPort, Recorder, ToolPort, ViolationRecord } from './ports.js';
import { SchemaRegistry } from './schemas.js';
import { hasTemplate, renderTemplate } from './templates.js';

/**
 * THE CAPABILITY INTERPRETER — docs/module3.md §7.
 *
 * Single-threaded AST walk, deterministic, step-limited. Every value is a TaintedValue; every
 * operation computes its result taint by the §5.2 rule and writes a derivation row; every call
 * passes the gate. There is no path from an expression to a tool that does not go through
 * `gate()` — the only place a tool is invoked is `callTool()`, and it calls the gate first.
 *
 * Determinism (M7 replay depends on it): no clock, no randomness, no iteration-order
 * dependence. Value refs are a counter; time and seed come from RunContext as recorded inputs.
 */

export interface RunContext {
  tenantId: string;
  runId: string;
  /** Pinned planner model id — recorded with the program for replay. */
  modelId: string;
  mode: 'execute' | 'simulate';
  /** Recorded, never read from the clock. Exposed to programs as `now`. */
  now: string;
  stepLimit?: number;
  maxCollection?: number;
  /** Calls a human already approved (M8); a REQUIRE_APPROVAL gate on these proceeds. */
  approvedNodes?: ReadonlySet<string>;
  /** Names bound before the program runs, with their taint (the objective is TRUSTED). */
  inputs?: Record<string, { data: unknown; taint: Taint; sourceId?: string }>;
}

export interface InterpreterDeps {
  tools: ToolPort;
  declarations: DeclarationPort;
  extractor: ExtractorPort;
  entities: EntityPort;
  recorder: Recorder;
  pager?: Pager;
  policy?: PolicyPort;
  schemas?: SchemaRegistry;
}

export interface CallTrace {
  nodeId: string;
  toolId: string;
  gate: GateDecision['decision'];
  policy?: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';
  argTaint: Taint;
  args: Record<string, unknown>;
  argTaints: Array<{ path: string; taint: Taint; dataTaint: Taint; sourceIds: readonly string[] }>;
  executed: boolean;
  ok?: boolean;
  error?: string;
  effect?: unknown;
}

export type RunStatus = 'completed' | 'awaiting_approval' | 'violated' | 'invalid' | 'failed';

export interface RunResult {
  status: RunStatus;
  programDigest: string;
  emits: TaintedValue[];
  calls: CallTrace[];
  steps: number;
  validationErrors?: ValidationIssue[];
  violation?: ViolationRecord;
  pending?: { nodeId: string; toolId: string; reason: string; argTaint: Taint };
  error?: string;
  /** Deterministic trace digest: same program + same inputs → same digest. */
  traceDigest: string;
}

class Halt extends Error {
  constructor(readonly status: Exclude<RunStatus, 'completed' | 'invalid'>, message: string) {
    super(message);
  }
}

export function programDigest(program: Program): string {
  return `sha256:${createHash('sha256').update(canonicalJson(program)).digest('hex')}`;
}

/** Recursively unwraps M2 provenance envelopes ({ value, sourceId, taint }), collecting them. */
function unwrapSourced(v: unknown, found: Array<{ sourceId: string; taint: Taint; value: unknown }>): unknown {
  if (Array.isArray(v)) return v.map((x) => unwrapSourced(x, found));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 3 && 'value' in o && typeof o['sourceId'] === 'string' && (o['taint'] === 'TRUSTED' || o['taint'] === 'ORG' || o['taint'] === 'UNTRUSTED')) {
      found.push({ sourceId: o['sourceId'], taint: o['taint'], value: o['value'] });
      return unwrapSourced(o['value'], found);
    }
    return Object.fromEntries(keys.map((k) => [k, unwrapSourced(o[k], found)]));
  }
  return v;
}

function getPath(data: unknown, path: ReadonlyArray<string | number>): unknown {
  let cur = data;
  for (const seg of path) {
    if (cur === null || cur === undefined) return null;
    if (typeof seg === 'number') cur = Array.isArray(cur) ? cur[seg] : null;
    else cur = typeof cur === 'object' && !Array.isArray(cur) && Object.hasOwn(cur as object, seg) ? (cur as Record<string, unknown>)[seg] : null;
  }
  return cur === undefined ? null : cur;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.match(/[^.[\]]+/g) ?? [];
  let cur: Record<string, unknown> | unknown[] = target;
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    const nextIsIndex = /^\d+$/.test(segs[i + 1] ?? '');
    const key: string | number = /^\d+$/.test(seg) ? Number(seg) : seg;
    const bag = cur as Record<string | number, unknown>;
    if (last) bag[key] = value;
    else {
      if (bag[key] === undefined) bag[key] = nextIsIndex ? [] : {};
      cur = bag[key] as Record<string, unknown>;
    }
  });
}

const truthy = (v: unknown) => !(v === false || v === null || v === 0 || v === '' || (Array.isArray(v) && v.length === 0));

export class Interpreter {
  private readonly schemas: SchemaRegistry;

  constructor(private readonly deps: InterpreterDeps) {
    this.schemas = deps.schemas ?? new SchemaRegistry();
  }

  async run(program: Program, ctx: RunContext): Promise<RunResult> {
    const digest = programDigest(program);
    const decls = new Map<string, ToolDeclarationRecord>();
    for (const c of callsOf(program)) {
      if (!decls.has(c.tool)) {
        const d = await this.deps.declarations.get(ctx.tenantId, c.tool);
        if (d) decls.set(c.tool, d);
      }
    }
    const inputs = Object.fromEntries(Object.entries(ctx.inputs ?? {}).map(([k, v]) => [k, { taint: v.taint, dataTaint: v.taint }]));
    const staticResult = validate(program, {
      tool: (id) => decls.get(id),
      hasSchema: (n) => this.schemas.has(n),
      hasTemplate,
      maxCollection: ctx.maxCollection ?? 100,
      inputs: { now: { taint: 'TRUSTED', dataTaint: 'TRUSTED' }, ...inputs },
    });
    await this.deps.recorder.program({
      tenantId: ctx.tenantId,
      runId: ctx.runId,
      ast: program,
      digest,
      modelId: ctx.modelId,
      valid: staticResult.valid,
      validationErrors: staticResult.valid ? null : staticResult.errors,
    });
    if (!staticResult.valid) {
      return { status: 'invalid', programDigest: digest, emits: [], calls: [], steps: 0, validationErrors: staticResult.errors, traceDigest: digestOf([]) };
    }
    return evaluate({ ...this.deps, schemas: this.schemas }, program, ctx, decls);
  }
}

/**
 * The evaluator without static validation. Interpreter.run() validates first; this layer is
 * exported so the soundness suite can prove the RUNTIME gate holds even for programs the
 * static validator would have rejected (defence in depth: the gate never assumes validation).
 */
export function evaluate(deps: InterpreterDeps, program: Program, ctx: RunContext, decls: Map<string, ToolDeclarationRecord>): Promise<RunResult> {
  return new Execution(deps, deps.schemas ?? new SchemaRegistry(), trace.getTracer('interpreter'), decls, ctx, programDigest(program)).run(program);
}

class Execution {
  private step = 0;
  private refSeq = 0;
  private readonly emits: TaintedValue[] = [];
  private readonly calls: CallTrace[] = [];
  private readonly traceLog: unknown[] = [];
  private violation: ViolationRecord | undefined;
  private pending: RunResult['pending'];

  constructor(
    private readonly deps: InterpreterDeps,
    private readonly schemas: SchemaRegistry,
    private readonly tracer: ReturnType<typeof trace.getTracer>,
    private readonly decls: Map<string, ToolDeclarationRecord>,
    private readonly ctx: RunContext,
    private readonly digest: string,
  ) {}

  private ref(): string {
    return `v${++this.refSeq}`;
  }

  private async record(op: string, v: TaintedValue, meta: { inputs?: readonly TaintedValue[]; context?: Taint; nodeId?: string } = {}): Promise<TaintedValue> {
    const nodeId = meta.nodeId;
    this.step += 1;
    if (this.step > (this.ctx.stepLimit ?? 10_000)) throw new Halt('failed', `step limit ${this.ctx.stepLimit ?? 10_000} exceeded`);
    const span = this.tracer.startSpan(`dsl.${op}`, { attributes: { step_index: this.step, op, taint: v.taint, run_id: this.ctx.runId, ...(nodeId ? { node_id: nodeId } : {}) } });
    span.end();
    const inputRefs = (meta.inputs ?? []).map((i) => i.valueRef);
    this.traceLog.push([this.step, op, v.valueRef, v.taint, v.dataTaint, v.sourceIds, inputRefs]);
    await this.deps.recorder.derivation({
      tenantId: this.ctx.tenantId,
      runId: this.ctx.runId,
      valueRef: v.valueRef,
      op,
      sourceIds: v.sourceIds,
      taint: v.taint,
      dataTaint: v.dataTaint,
      contextTaint: meta.context ?? 'TRUSTED',
      inputRefs,
      stepIndex: this.step,
      nodeId,
    });
    return v;
  }

  async run(program: Program): Promise<RunResult> {
    const scope = new Map<string, TaintedValue>();
    scope.set('now', literal(this.ctx.now, this.ref()));
    for (const [name, input] of Object.entries(this.ctx.inputs ?? {})) {
      scope.set(name, input.sourceId ? fromSource(input.data, { sourceId: input.sourceId, taint: input.taint }, this.ref()) : input.taint === 'TRUSTED' ? literal(input.data, this.ref()) : fromSource(input.data, { sourceId: `input:${name}`, taint: input.taint }, this.ref()));
    }
    let status: RunStatus = 'completed';
    let error: string | undefined;
    try {
      await this.block(program.body, scope, 'TRUSTED');
    } catch (e) {
      if (e instanceof Halt) {
        status = e.status;
        error = e.message;
      } else {
        status = 'failed';
        error = e instanceof Error ? e.message : String(e);
      }
    }
    return {
      status,
      programDigest: this.digest,
      emits: this.emits,
      calls: this.calls,
      steps: this.step,
      ...(this.violation ? { violation: this.violation } : {}),
      ...(this.pending ? { pending: this.pending } : {}),
      ...(error && status !== 'completed' ? { error } : {}),
      traceDigest: digestOf(this.traceLog),
    };
  }

  private async block(body: Stmt[], outer: Map<string, TaintedValue>, ctxTaint: Taint): Promise<void> {
    const scope = new Map(outer); // block scope: nothing bound here is visible after the block
    for (const s of body) {
      switch (s.k) {
        case 'let':
          scope.set(s.name, await this.expr(s.value, scope, ctxTaint));
          break;
        case 'do': {
          const v = await this.call(s.call, scope, ctxTaint);
          if (s.as) scope.set(s.as, v);
          break;
        }
        case 'emit':
          {
            const v = await this.expr(s.value, scope, ctxTaint);
            this.emits.push(await this.record('emit', v, { inputs: [v], context: ctxTaint }));
          }
          break;
        case 'when': {
          const cond = await this.expr(s.cond, scope, ctxTaint);
          // Implicit flow: everything produced under this branch is at least as tainted as its condition.
          const inner = join(ctxTaint, cond.taint);
          if (truthy(cond.data)) await this.block(s.then, scope, inner);
          else if (s.otherwise) await this.block(s.otherwise, scope, inner);
          break;
        }
      }
    }
  }

  private d<T>(op: string, data: T, inputs: TaintedValue[], ctxTaint: Taint, extra: { extra?: Taint[]; extraSources?: string[] } = {}) {
    return this.record(op, derive(data, inputs, this.ref(), { context: ctxTaint, ...extra }), { inputs, context: ctxTaint });
  }

  private async expr(e: Expr, scope: Map<string, TaintedValue>, ctxTaint: Taint): Promise<TaintedValue> {
    switch (e.k) {
      case 'lit':
        return this.d('literal', e.value, [], ctxTaint);
      case 'ref': {
        const v = scope.get(e.name);
        if (!v) throw new Halt('failed', `unbound name ${e.name}`); // unreachable after validation
        // Always a new derivation, even in a TRUSTED context: the SHAPE of the trace must depend
        // on data only, never on taint (monotonicity and replay compare traces step by step).
        return this.d('ref', v.data, [v], ctxTaint);
      }
      case 'select': {
        const of = await this.expr(e.of, scope, ctxTaint);
        return this.d('select', getPath(of.data, e.path), [of], ctxTaint);
      }
      case 'object': {
        const parts: TaintedValue[] = [];
        const data: Record<string, unknown> = {};
        for (const [k, x] of e.fields) {
          const v = await this.expr(x, scope, ctxTaint);
          parts.push(v);
          data[k] = v.data;
        }
        return this.d('object', data, parts, ctxTaint);
      }
      case 'array': {
        const parts = [];
        for (const x of e.items) parts.push(await this.expr(x, scope, ctxTaint));
        return this.d('array', parts.map((p) => p.data), parts, ctxTaint);
      }
      case 'map':
      case 'filter': {
        const coll = await this.expr(e.of, scope, ctxTaint);
        if (!Array.isArray(coll.data)) throw new Halt('failed', `${e.k} over a non-collection`);
        const limit = e.limit ?? this.ctx.maxCollection ?? 100;
        if (coll.data.length > limit) throw new Halt('failed', `${e.k} over ${coll.data.length} items exceeds its bound of ${limit}`);
        const results: TaintedValue[] = [];
        const kept: unknown[] = [];
        for (const item of coll.data as unknown[]) {
          const el = await this.d('element', item, [coll], ctxTaint);
          const inner = new Map(scope).set(e.as, el);
          const r = await this.expr(e.body, inner, ctxTaint);
          results.push(r);
          if (e.k === 'filter' && truthy(r.data)) kept.push(item);
        }
        return this.d(e.k, e.k === 'map' ? results.map((r) => r.data) : kept, [coll, ...results], ctxTaint);
      }
      case 'extract': {
        const of = await this.expr(e.of, scope, ctxTaint);
        const schema = this.schemas.get(e.schema);
        if (!schema) throw new Halt('failed', `no extraction schema ${e.schema}`);
        const raw = await this.deps.extractor.extract({
          content: of.data,
          schema: e.schema,
          jsonSchema: this.schemas.describe().find((s) => s.name === e.schema)!.jsonSchema,
          purpose: `extract ${e.schema}`,
        });
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          // A model that will not conform when given untrusted content is a signal, not a fault.
          await this.violate({
            nodeId: null,
            toolId: `extract:${e.schema}`,
            kind: 'SCHEMA',
            attemptedTaint: of.taint,
            declaredMax: of.taint,
            argPath: e.schema,
            sourceIds: of.sourceIds,
            severity: 'HIGH',
            detail: `extractor output did not match ${e.schema}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          });
          throw new Halt('violated', 'extraction schema violation');
        }
        // Extraction never launders: the result is exactly as tainted as what it was read from.
        return this.d('extract', parsed.data, [of], ctxTaint);
      }
      case 'resolve': {
        const key = await this.expr(e.of, scope, ctxTaint);
        const lookup = async (k: unknown) => (typeof k === 'string' && k ? await this.deps.entities.lookup(this.ctx.tenantId, e.registry, k) : null);
        const data = Array.isArray(key.data) ? await Promise.all(key.data.map(lookup)) : await lookup(key.data);
        return this.record('resolve', endorse(data, key, { name: e.registry, taint: 'TRUSTED' }, this.ref(), { context: ctxTaint }), { inputs: [key], context: ctxTaint });
      }
      case 'concat': {
        const parts = [];
        for (const p of e.parts) parts.push(await this.expr(p, scope, ctxTaint));
        const s = parts
          .map((p) => {
            if (p.data === null) return '';
            if (typeof p.data === 'object') throw new Halt('failed', 'concat of a non-scalar value');
            return String(p.data);
          })
          .join('');
        return this.d('concat', s, parts, ctxTaint);
      }
      case 'compare': {
        const l = await this.expr(e.left, scope, ctxTaint);
        const r = await this.expr(e.right, scope, ctxTaint);
        let out: boolean;
        if (e.op === '==' || e.op === '!=') out = (canonicalJson(l.data) === canonicalJson(r.data)) === (e.op === '==');
        else {
          const ok = (typeof l.data === 'number' && typeof r.data === 'number') || (typeof l.data === 'string' && typeof r.data === 'string');
          const a = l.data as number | string;
          const b = r.data as number | string;
          out = ok && (e.op === '<' ? a < b : e.op === '<=' ? a <= b : e.op === '>' ? a > b : a >= b);
        }
        // Even booleans carry taint.
        return this.d('compare', out, [l, r], ctxTaint);
      }
      case 'logic': {
        // Both sides are evaluated: the result's taint is the join of both, whichever decided.
        const l = await this.expr(e.left, scope, ctxTaint);
        const r = await this.expr(e.right, scope, ctxTaint);
        return this.d('logic', e.op === 'and' ? truthy(l.data) && truthy(r.data) : truthy(l.data) || truthy(r.data), [l, r], ctxTaint);
      }
      case 'not': {
        const v = await this.expr(e.of, scope, ctxTaint);
        return this.d('not', !truthy(v.data), [v], ctxTaint);
      }
      case 'count': {
        const v = await this.expr(e.of, scope, ctxTaint);
        const n = Array.isArray(v.data) ? v.data.length : v.data && typeof v.data === 'object' ? Object.keys(v.data).length : v.data === null ? 0 : 1;
        return this.d('count', n, [v], ctxTaint);
      }
      case 'coalesce': {
        const parts = [];
        for (const p of e.parts) parts.push(await this.expr(p, scope, ctxTaint));
        const chosen = parts.find((p) => p.data !== null && p.data !== undefined);
        // Taint of ALL candidates: which one was chosen is itself information.
        return this.d('coalesce', chosen ? chosen.data : null, parts, ctxTaint);
      }
      case 'render': {
        const c = await this.expr(e.context, scope, ctxTaint);
        return this.d('render', renderTemplate(e.template, c.data), [c], ctxTaint);
      }
      case 'call':
        return this.call(e, scope, ctxTaint);
    }
  }

  private async violate(v: Omit<ViolationRecord, 'tenantId' | 'runId' | 'programRef'>): Promise<void> {
    const rec: ViolationRecord = { ...v, tenantId: this.ctx.tenantId, runId: this.ctx.runId, programRef: this.digest };
    this.violation = rec;
    await this.deps.recorder.violation(rec);
    await this.deps.pager?.page(rec).catch(() => undefined);
  }

  private async call(c: CallExpr, scope: Map<string, TaintedValue>, ctxTaint: Taint): Promise<TaintedValue> {
    const decl = this.decls.get(c.tool);
    if (!decl) {
      // No declaration, no call: unresolved provenance fails closed.
      await this.violate({ nodeId: c.id, toolId: c.tool, kind: 'PROVENANCE', attemptedTaint: 'UNTRUSTED', declaredMax: 'TRUSTED', argPath: 'tool', sourceIds: [], severity: 'CRITICAL', detail: `no declaration for ${c.tool}` });
      throw new Halt('violated', `no declaration for ${c.tool}`);
    }
    const leaves = [];
    for (const l of argLeaves(c.args)) leaves.push({ path: l.path, value: await this.expr(l.expr, scope, ctxTaint) });
    const args: Record<string, unknown> = {};
    for (const l of leaves) setPath(args, l.path, l.value.data);

    const g = gate(decl, leaves, ctxTaint);
    const traceEntry: CallTrace = {
      nodeId: c.id,
      toolId: c.tool,
      gate: g.decision,
      argTaint: g.decision === 'VIOLATION' ? g.attemptedTaint : g.argTaint,
      args,
      argTaints: leaves.map((l) => ({ path: l.path, taint: l.value.taint, dataTaint: l.value.dataTaint, sourceIds: l.value.sourceIds })),
      executed: false,
    };
    this.calls.push(traceEntry);

    if (g.decision === 'VIOLATION') {
      await this.violate({
        nodeId: c.id,
        toolId: c.tool,
        kind: g.kind,
        attemptedTaint: g.attemptedTaint,
        declaredMax: g.kind === 'RECIPIENT' ? 'TRUSTED' : decl.maxTaint,
        argPath: g.argPath,
        sourceIds: g.sourceIds,
        severity: g.severity,
        detail: g.reason,
      });
      throw new Halt('violated', g.reason);
    }
    let needsApproval = g.decision === 'REQUIRE_APPROVAL';
    let reason = g.decision === 'REQUIRE_APPROVAL' ? g.reason : '';
    if (this.deps.policy) {
      const p = await this.deps.policy.evaluate({ tenantId: this.ctx.tenantId, runId: this.ctx.runId, nodeId: c.id, tool: decl, argTaint: g.argTaint, taintPressure: g.taintPressure, args });
      traceEntry.policy = p.decision;
      if (p.decision === 'DENY') throw new Halt('failed', `policy denied ${c.tool}${p.reason ? `: ${p.reason}` : ''}`);
      if (p.decision === 'REQUIRE_APPROVAL') {
        needsApproval = true;
        reason = p.reason ?? 'policy requires approval';
      }
    }
    if (needsApproval && this.ctx.mode === 'execute' && !this.ctx.approvedNodes?.has(c.id)) {
      this.pending = { nodeId: c.id, toolId: c.tool, reason, argTaint: g.argTaint };
      throw new Halt('awaiting_approval', reason);
    }

    for (const l of leaves) if (!isTainted(l.value)) throw new Halt('failed', 'argument lost provenance'); // belt and braces
    // A dry run still READS: an R0 call has no effect, and a plan over empty simulated reads
    // shows nothing. It stays simulated if it needed approval — a read with untrusted
    // arguments that leaves the organization (a fetched URL) is egress, dry run or not.
    const mode = this.ctx.mode === 'simulate' && decl.reversibility === 'R0' && !needsApproval ? 'execute' : this.ctx.mode;
    const res = await this.deps.tools.invoke({ tenantId: this.ctx.tenantId, runId: this.ctx.runId, nodeId: c.id, toolId: c.tool, args, mode });
    traceEntry.executed = mode === 'execute';
    traceEntry.ok = res.ok;
    if (!res.ok) {
      traceEntry.error = `${res.error.code}: ${res.error.message}`;
      throw new Halt('failed', `${c.tool} failed: ${res.error.code}`);
    }
    traceEntry.effect = { summary: res.effect.summary, externalRecipients: res.effect.externalRecipients, fidelity: res.effect.fidelity };
    const found: Array<{ sourceId: string; taint: Taint; value: unknown }> = [];
    const data = unwrapSourced(res.effect.detail, found);
    for (const f of found) {
      await this.deps.recorder.source({ tenantId: this.ctx.tenantId, runId: this.ctx.runId, uri: f.sourceId, taint: f.taint, digest: digestOf(f.value), meta: { toolId: c.tool, nodeId: c.id } });
    }
    // toolResult: join(declared output taint, taint(args), every envelope's own label).
    return this.record(
      'toolResult',
      derive(data, leaves.map((l) => l.value), this.ref(), { context: ctxTaint, extra: [decl.outputTaint, ...found.map((f) => f.taint)], extraSources: found.map((f) => f.sourceId) }),
      { inputs: leaves.map((l) => l.value), context: ctxTaint, nodeId: c.id },
    );
  }
}
