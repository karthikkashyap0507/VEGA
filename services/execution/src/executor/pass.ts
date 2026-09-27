import type { Ambiguity, ToolDeclarationRecord, ToolResult } from '@vega/contracts';
import { argsDigest } from '@vega/connector-sdk';
import type { DurableContext, Hooks, PolicyDecision, SimulationResult, StepContext } from '@vega/orchestration';
import {
  RunSuspended,
  type DeclarationPort,
  type DerivationRecord,
  type Entity,
  type EntityPort,
  type ExtractorPort,
  type Pager,
  type ProgramRecord,
  type Recorder,
  type SchemaRegistry,
  type SourceRecord,
  type ToolInvocation,
  type ToolPort,
  type ViolationRecord,
} from '@vega/interpreter';
import type { JournalRow, LoadedRun, RunStore } from '@vega/runs';
import type { ReversibilityEngine } from '../reversibility/engine.js';
import type { TaintLevel as Taint } from '@vega/contracts';

/**
 * ONE PASS of the interpreter over one program version, inside a durable run.
 *
 * The workflow re-runs the (deterministic) program from the top whenever it resumes — after an
 * approval, a re-authorization, a crash. Everything non-deterministic the program touches goes
 * through here and is made replayable:
 *
 *   · tool calls   → the task_nodes journal, looked up by (program version, call_seq) BEFORE
 *                    anything else happens; a `done` row returns its recorded result
 *   · extractions  → memoized per workflow (the model would not answer the same way twice)
 *   · resolutions  → memoized per workflow (the directory may change mid-run)
 *
 * and each is a durable step, so a restarted process replays recorded outcomes instead of
 * repeating them.
 *
 * THE HOOK CHAIN (docs/module4.md §5.3), for a call not yet in the journal:
 *
 *   policy → simulate → approval → receipt:pre → captureCompensator → [journal: running]
 *     → CALL → [journal: done|failed|unknown] → verify → receipt:post
 *
 * The M3 gate has already run in the interpreter (it refuses violations before any port sees a
 * call; its REQUIRE_APPROVAL arrives here as `gate.decision` and the approval step honours it
 * whatever the approval hook says).
 *
 * AT-MOST-ONCE. A row found `running` means a process died between "about to call" and
 * "recorded the outcome". Reads are simply repeated. A KEYED or NATIVE tool is re-invoked with
 * the SAME idempotency key: the M2 ledger replays a recorded success and refuses an unfinished
 * claim as OUTCOME_UNKNOWN. Anything else that is not a read is marked UNKNOWN and the run goes
 * to NEEDS_ATTENTION (§8.4): for an action whose outcome is uncertain, guessing is worse than
 * asking.
 */

export interface ToolInvoker {
  execute(i: { tenantId: string; connectorId: string; toolId: string; args: unknown; runId: string; nodeId: string }): Promise<ToolResult<unknown>>;
  simulate(i: { tenantId: string; connectorId: string; toolId: string; args: unknown; runId: string; nodeId: string }): Promise<ToolResult<unknown>>;
}

export interface ExecutorLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface ExecutorDeps {
  store: RunStore;
  invoker: ToolInvoker;
  declarations: DeclarationPort;
  extractor: ExtractorPort;
  entities: EntityPort;
  hooks: Hooks;
  schemas: SchemaRegistry;
  recorder: () => Recorder & { flush(): Promise<void> };
  log: ExecutorLog;
  pager?: Pager | undefined;
  /** Refuse calls without a valid run credential (§10). Off only in loudly-warned development. */
  requireGrant: boolean;
  now?: () => number;
  /** Cost of one extraction, in cents (the only model call in the execution plane). */
  extractCostCents?: number;
  /** Module 6: compensations bound to outcomes, divergence, holds, rollbacks. */
  reversibility?: ReversibilityEngine | undefined;
}

export type StopReason =
  | 'policy_denial'
  | 'policy_unavailable'
  | 'verify_failure'
  | 'unknown_outcome'
  | 'not_allowed'
  | 'limit'
  | 'receipt_unavailable'
  | 'nondeterminism'
  | 'infrastructure'
  | 'rejected'
  | 'divergence';

/** What the run is waiting for. Stored in runs.pending_json; the UI's ActionCard renders it. */
export interface PendingAction {
  kind: 'approval' | 'clarification' | 'reauthorize' | 'credential' | 'hold' | 'replan';
  reason: string;
  key?: string;
  version?: number;
  callSeq?: number;
  nodeRowId?: string;
  dslNodeId?: string;
  toolId?: string;
  args?: Record<string, unknown>;
  argTaint?: Taint;
  argTaints?: Array<{ path: string; taint: Taint; dataTaint: Taint; sourceIds: readonly string[] }>;
  reversibility?: string;
  egressClass?: string;
  effect?: { summary: string; externalRecipients: string[]; recordsAffected: unknown[]; fidelity: string } | undefined;
  policy?: PolicyDecision;
  /** REQUIRE_DUAL_APPROVAL: 2. Who has approved so far (distinct users; never the requester under SoD). */
  approvalsRequired?: number;
  approvedBy?: string[];
  /** A windowed hold: it releases itself at `releaseAt` unless revoked first. */
  holdWindowMs?: number;
  /** Module 6: the action row and (once the workflow opened it) the hold row. */
  actionId?: string;
  holdId?: string;
  /** The content was edited during an earlier hold of this call (edit and requeue). */
  edited?: boolean;
  heldAt?: string;
  releaseAt?: string;
  assumptions?: string[];
  ambiguity?: Ambiguity;
  connector?: string;
}

export type SuspendStatus = 'awaiting_approval' | 'awaiting_input' | 'held';

export type CallOutcome =
  | { kind: 'result'; result: ToolResult<unknown> }
  | { kind: 'suspend'; status: SuspendStatus; pending: PendingAction }
  | { kind: 'stop'; reason: StopReason; message: string };

export class PassStopped extends Error {
  constructor(
    readonly reason: StopReason,
    message: string,
  ) {
    super(message);
    this.name = 'PassStopped';
  }
}

export interface CommittedFact {
  toolId: string;
  argsDigest: string;
  version: number;
  nodeRowId: string;
  result: unknown;
}

export interface PassConfig {
  ctx: DurableContext;
  deps: ExecutorDeps;
  run: LoadedRun;
  version: number;
  passNo: number;
  approvals: ReadonlySet<string>;
  /** Hold keys whose window has passed (or that someone released early): they run now. */
  released: ReadonlySet<string>;
  /** Non-read calls committed by EARLIER program versions: facts, never redone (§5.5). */
  committed: readonly CommittedFact[];
  memo: Map<string, unknown>;
}

const READ = 'R0';
const isIrreversible = (d: ToolDeclarationRecord) => d.reversibility === 'R2' || d.reversibility === 'R3';
// Canonical (key-order independent): a journaled result comes back from jsonb with its keys
// reordered, and must still find the memoized extraction it fed the first time.
const digest = (v: unknown) => argsDigest(v).slice(0, 32);

/** Failures that PROVE nothing happened: a resumed run may try the call again. */
const PROVABLY_NOT_APPLIED = new Set(['AUTH_EXPIRED', 'CONNECTOR_UNAVAILABLE', 'RATE_LIMITED', 'PERMISSION_DENIED', 'EGRESS_DENIED', 'VALIDATION']);

function summarize(r: ToolResult<unknown>) {
  return r.ok ? { summary: r.effect.summary, externalRecipients: r.effect.externalRecipients, recordsAffected: r.effect.recordsAffected, fidelity: r.effect.fidelity } : null;
}

async function persist<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 200 * 2 ** i));
    }
  }
  throw last;
}

export class DurablePass implements ToolPort {
  callSeq = 0;
  private extractSeq = 0;
  private resolveSeq = 0;
  suspension: { status: SuspendStatus; pending: PendingAction } | undefined;
  stop: { reason: StopReason; message: string } | undefined;
  failure: { toolId: string; code: string; message: string; callSeq: number } | undefined;
  readonly recorder: Recorder & { flush(): Promise<void> };
  readonly extractor: ExtractorPort;
  readonly entities: EntityPort;

  constructor(private readonly cfg: PassConfig) {
    const inner = cfg.deps.recorder();
    const p = (ref: string) => `p${cfg.version}.${ref}`;
    // Value refs restart at v1 on every program version; prefixing keeps each version's
    // provenance graph distinct, while a re-run of the SAME version dedupes to the same rows.
    this.recorder = {
      program: (r: ProgramRecord) => inner.program(r),
      source: (s: SourceRecord) => inner.source(s),
      derivation: (d: DerivationRecord) => inner.derivation({ ...d, valueRef: p(d.valueRef), inputRefs: d.inputRefs.map(p) }),
      violation: (v: ViolationRecord) => inner.violation(v),
      flush: () => inner.flush(),
    };
    this.extractor = { extract: (input) => this.extract(input) };
    this.entities = { lookup: (tenantId, registry, key) => this.lookup(tenantId, registry, key) };
  }

  get pager(): Pager | undefined {
    return this.cfg.deps.pager;
  }

  // ------------------------------------------------------------------ memoized reads
  private async extract(input: Parameters<ExtractorPort['extract']>[0]): Promise<unknown> {
    const { ctx, version, passNo, memo, deps, run } = this.cfg;
    const seq = ++this.extractSeq;
    const mk = `x:${version}:${seq}:${digest([input.schema, input.content])}`;
    if (!memo.has(mk)) {
      const out = await ctx.step(`extract:v${version}:p${passNo}:${seq}`, async () => {
        try {
          const value = await deps.extractor.extract(input);
          const cost = await deps.store.addCost(run.tenantId, run.id, deps.extractCostCents ?? 1);
          return { ok: true as const, value, cost };
        } catch (e) {
          return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
        }
      });
      memo.set(mk, out);
    }
    const out = memo.get(mk) as { ok: true; value: unknown; cost: number } | { ok: false; message: string };
    if (!out.ok) throw new Error(`extraction failed: ${out.message}`);
    if (out.cost > run.spec.limits.maxCostCents) this.halt('limit', `max_cost_cents ${run.spec.limits.maxCostCents} exceeded (${out.cost})`);
    return out.value;
  }

  private async lookup(tenantId: string, registry: 'directory' | 'contacts', key: string): Promise<Entity | null> {
    const { ctx, version, passNo, memo, deps } = this.cfg;
    const seq = ++this.resolveSeq;
    const mk = `r:${version}:${seq}:${registry}:${key}`;
    if (!memo.has(mk)) {
      memo.set(mk, await ctx.step(`resolve:v${version}:p${passNo}:${seq}`, () => deps.entities.lookup(tenantId, registry, key), { retries: 3 }));
    }
    return memo.get(mk) as Entity | null;
  }

  // ------------------------------------------------------------------ tool calls
  private halt(reason: StopReason, message: string): never {
    this.stop ??= { reason, message };
    throw new PassStopped(reason, message);
  }

  async invoke(inv: ToolInvocation): Promise<ToolResult<unknown>> {
    const { ctx, run, version, passNo } = this.cfg;
    const seq = ++this.callSeq;
    const decl = inv.declaration;
    if (!decl || !inv.gate) this.halt('not_allowed', `call ${inv.toolId} reached the executor without gate context`);
    if (inv.mode !== 'execute') this.halt('not_allowed', 'the durable executor only executes; dry runs use the program API');
    // Deterministic checks first: they need no I/O and replay identically.
    if (seq > run.spec.limits.maxSteps) this.halt('limit', `max_steps ${run.spec.limits.maxSteps} reached`);
    if (!run.spec.allowedTools.includes(inv.toolId)) this.halt('not_allowed', `${inv.toolId} is not in this agent's allowed tools`);

    // C1's ambiguity policy, enforced at the call (defence in depth behind the plan-time check):
    // an R2/R3 action whose arguments carry an unresolved best guess waits for a human.
    const unresolved = run.objective.ambiguities.filter((a) => !a.resolution);
    const touched = unresolved.filter((a) => inv.gate!.argTaints.some((t) => t.sourceIds.includes(`entity:${a.binding}`)));
    if (touched.length && isIrreversible(decl)) {
      const pending: PendingAction = { kind: 'clarification', reason: `"${touched[0]!.raw}" is ambiguous and ${inv.toolId} cannot be undone`, ambiguity: touched[0]!, toolId: inv.toolId, dslNodeId: inv.nodeId, version, callSeq: seq };
      this.suspension = { status: 'awaiting_input', pending };
      throw new RunSuspended('awaiting_input', { nodeId: inv.nodeId, toolId: inv.toolId, reason: pending.reason, argTaint: inv.gate.argTaint });
    }
    const assumptions = touched.map((a) => `${a.field}: assumed "${a.candidates.find((c) => c.id === a.binding)?.label ?? a.binding}"`);

    const outcome = await ctx.step(`call:v${version}:p${passNo}:${seq}`, () => this.execute(inv, decl, seq, assumptions));
    switch (outcome.kind) {
      case 'result':
        if (!outcome.result.ok) this.failure = { toolId: inv.toolId, code: outcome.result.error.code, message: outcome.result.error.message, callSeq: seq };
        return outcome.result;
      case 'suspend':
        this.suspension = { status: outcome.status, pending: outcome.pending };
        throw new RunSuspended(outcome.status, { nodeId: inv.nodeId, toolId: inv.toolId, reason: outcome.pending.reason, argTaint: inv.gate.argTaint });
      case 'stop':
        return this.halt(outcome.reason, outcome.message);
    }
  }

  /** The body of ONE durable step. Never throws before the call; returns what happened. */
  private async execute(inv: ToolInvocation, decl: ToolDeclarationRecord, seq: number, assumptions: string[]): Promise<CallOutcome> {
    const { run, version, deps } = this.cfg;
    const d = argsDigest(inv.args);
    let row: JournalRow;
    try {
      ({ row } = await deps.store.claimCall(run.tenantId, run.id, { version, callSeq: seq, dslNodeId: inv.nodeId, toolId: inv.toolId, args: inv.args, argsDigest: d }));
    } catch (e) {
      return { kind: 'stop', reason: 'infrastructure', message: `journal unavailable: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (row.argsDigest !== d || row.toolId !== inv.toolId) {
      return { kind: 'stop', reason: 'nondeterminism', message: `call ${seq} of program v${version} replayed as ${inv.toolId} with different arguments than were journaled` };
    }
    switch (row.status) {
      case 'done':
        return { kind: 'result', result: row.result as ToolResult<unknown> };
      case 'unknown':
        return { kind: 'stop', reason: 'unknown_outcome', message: `${inv.toolId} (call ${seq}) has an unknown outcome` };
      case 'skipped':
        return { kind: 'stop', reason: 'rejected', message: `${inv.toolId} (call ${seq}) was rejected` };
      case 'failed': {
        const code = (row.error as { code?: string } | null)?.code ?? '';
        if (!PROVABLY_NOT_APPLIED.has(code)) return { kind: 'result', result: { ok: false, error: row.error as { code: 'PROVIDER_ERROR'; message: string } } };
        break; // nothing happened: a resumed run may try again
      }
      case 'running':
        return this.recover(row, inv, decl, seq, d, assumptions);
      default:
        break;
    }
    try {
      return await this.chain(row, inv, decl, seq, d, assumptions);
    } catch (e) {
      // Only reachable before the journal said `running`: nothing was called.
      if (e instanceof CalledError) throw e.cause;
      return { kind: 'stop', reason: 'infrastructure', message: e instanceof Error ? e.message : String(e) };
    }
  }

  private stepContext(inv: ToolInvocation, decl: ToolDeclarationRecord, seq: number, nodeRowId: string): StepContext {
    const { run, version } = this.cfg;
    return {
      tenantId: run.tenantId,
      runId: run.id,
      programVersion: version,
      nodeId: inv.nodeId,
      callSeq: seq,
      nodeRowId,
      trigger: run.trigger,
      toolId: inv.toolId,
      tool: decl,
      args: inv.args,
      argTaint: inv.gate!.argTaint,
      argTaints: inv.gate!.argTaints.map((a) => ({ ...a, sourceIds: [...a.sourceIds] })),
      principalUserId: run.principalUserId,
      agentId: run.agentId,
      agentVersion: run.agentVersion,
      workspaceId: run.workspaceId,
      runCostCents: run.costCents,
      connectorId: this.binding(inv.toolId, decl) ?? null,
      gate: { decision: inv.gate!.decision, ...(inv.gate!.reason ? { reason: inv.gate!.reason } : {}) },
    };
  }

  private binding(toolId: string, decl: ToolDeclarationRecord): string | undefined {
    const key = toolId.startsWith('mcp.') ? toolId.split('.').slice(0, 2).join('.') : decl.connectorKind;
    return this.cfg.run.checkpoint.bindings[key];
  }

  private async chain(row: JournalRow, inv0: ToolInvocation, decl: ToolDeclarationRecord, seq: number, d0: string, assumptions: string[]): Promise<CallOutcome> {
    const { run, version, deps, approvals, released, committed } = this.cfg;
    const store = deps.store;
    const mark = (patch: Parameters<RunStore['markNode']>[3]) => store.markNode(run.tenantId, run.id, row.id, patch);
    const { inv, d } = await this.effective(inv0, seq, d0);

    // A non-read that an earlier plan version already committed with these exact arguments is a
    // fact: return what happened, never do it again.
    if (decl.reversibility !== READ) {
      const fact = committed.find((c) => c.toolId === inv.toolId && c.argsDigest === d);
      if (fact) {
        await mark({ status: 'done', result: fact.result, effect: { ...(summarize(fact.result as ToolResult<unknown>) ?? {}), replayedFrom: fact.nodeRowId }, end: true });
        return { kind: 'result', result: fact.result as ToolResult<unknown> };
      }
    }

    // The run credential (§10): ≤15 minutes, scoped to the agent's tools. Checked inside the
    // step, so the (clock-dependent) answer is recorded and replays identically.
    if (deps.requireGrant) {
      const g = run.checkpoint.grant;
      if (!g || Date.parse(g.expiresAt) <= (deps.now ?? Date.now)()) {
        await mark({ status: 'held' });
        return { kind: 'suspend', status: 'held', pending: { kind: 'credential', reason: 'the run credential expired; waiting for a fresh one', toolId: inv.toolId, version, callSeq: seq } };
      }
      if (!g.scopes.includes(`tool:${inv.toolId}`)) {
        await mark({ status: 'failed', error: { code: 'PERMISSION_DENIED', message: 'run credential lacks this tool' }, end: true });
        return { kind: 'stop', reason: 'not_allowed', message: `the run credential is not scoped to ${inv.toolId}` };
      }
    }

    const sctx = this.stepContext(inv, decl, seq, row.id);
    const hooks = deps.hooks;
    const base: PendingAction = {
      kind: 'approval',
      reason: '',
      version,
      callSeq: seq,
      nodeRowId: row.id,
      dslNodeId: inv.nodeId,
      toolId: inv.toolId,
      args: inv.args,
      argTaint: inv.gate!.argTaint,
      argTaints: inv.gate!.argTaints,
      reversibility: decl.reversibility,
      egressClass: decl.egressClass,
      ...(assumptions.length ? { assumptions } : {}),
    };

    // 1 — policy (M5). A DENY ends the call here; a fail-closed DENY (the engine could not
    // decide) ends the RUN — replanning around an outage would only meet it again.
    const policy = await hooks.policy(sctx);
    if (policy.decision === 'DENY') {
      const code = policy.failClosed ? 'POLICY_UNAVAILABLE' : 'POLICY_DENIED';
      await mark({ status: 'failed', error: { code, message: policy.reason ?? 'denied by policy', ...(policy.evaluationId ? { evaluationId: policy.evaluationId } : {}) }, end: true });
      if (policy.failClosed) return { kind: 'stop', reason: 'policy_unavailable', message: `the policy engine could not decide on ${inv.toolId}; denied (fail closed): ${policy.reason ?? ''}` };
      return { kind: 'stop', reason: 'policy_denial', message: `policy denied ${inv.toolId}${policy.reason ? `: ${policy.reason}` : ''}` };
    }
    // 2 — simulate (M6)
    const sim: SimulationResult = await hooks.simulate(sctx);
    const effect = sim.ok ? { summary: sim.effect.summary, externalRecipients: sim.effect.externalRecipients, recordsAffected: sim.effect.recordsAffected, fidelity: sim.effect.fidelity } : undefined;
    const key = d === d0 ? `v${version}:${seq}:${d}` : `v${version}:${seq}:${d0}~${d.slice(0, 16)}`;
    const held = async () => {
      await mark({ status: 'held', effect });
      return store.upsertAction(run.tenantId, { runId: run.id, nodeRowId: row.id, toolId: inv.toolId, argsDigest: d, taint: inv.gate!.argTaint, reversibility: decl.reversibility, state: 'HELD', riskScore: policy.riskScore ?? null, riskTier: policy.riskTier ?? null });
    };
    if (d !== d0) base.edited = true;
    if (policy.decision === 'HOLD' && !released.has(key)) {
      const actionId = await held();
      return { kind: 'suspend', status: 'held', pending: { ...base, kind: 'hold', key, actionId, reason: policy.reason ?? 'held by policy', policy, effect } };
    }
    // 3 — approval (M8). The gate's REQUIRE_APPROVAL (untrusted content leaving the org) is
    // folded in, and honoured below even if an approval hook were to say PROCEED.
    const needs = (p: PolicyDecision) => p.decision === 'REQUIRE_APPROVAL' || p.decision === 'REQUIRE_DUAL_APPROVAL';
    const merged: PolicyDecision =
      inv.gate!.decision === 'REQUIRE_APPROVAL' && !needs(policy)
        ? { ...policy, decision: 'REQUIRE_APPROVAL', reason: inv.gate!.reason ?? 'untrusted content influences this action', approverRole: policy.approverRole ?? null }
        : policy;
    const approved = approvals.has(key);
    const approval = await hooks.approval(sctx, sim, merged, approved);
    if (approval.decision === 'WAIT' || (needs(merged) && !approved)) {
      if (approval.decision !== 'WAIT') deps.log.error({ run_id: run.id, tool_id: inv.toolId }, 'approval hook returned PROCEED for a call that requires approval; holding it anyway');
      await mark({ status: 'approving', effect });
      const reason = approval.decision === 'WAIT' ? approval.reason : (merged.reason ?? 'approval required');
      const approvalsRequired = merged.decision === 'REQUIRE_DUAL_APPROVAL' ? 2 : 1;
      return { kind: 'suspend', status: 'awaiting_approval', pending: { ...base, kind: 'approval', key, reason, policy: merged, effect, approvalsRequired, approvedBy: [] } };
    }
    // 3b — the hold window (M5 ALLOW_WITH_HOLD, or a policy's hold after approval). The action
    // waits, revocable, and then runs by itself: `released` says its window has passed.
    const holdMs = merged.decision === 'ALLOW_WITH_HOLD' || needs(merged) ? (merged.holdWindowMs ?? null) : null;
    if (holdMs && holdMs > 0 && !released.has(key)) {
      const actionId = await held();
      const heldAt = (deps.now ?? Date.now)();
      return {
        kind: 'suspend',
        status: 'held',
        pending: {
          ...base,
          kind: 'hold',
          key,
          actionId,
          reason: merged.reason ?? 'held by policy',
          policy: merged,
          effect,
          holdWindowMs: holdMs,
          heldAt: new Date(heldAt).toISOString(),
          releaseAt: new Date(heldAt + holdMs).toISOString(),
        },
      };
    }
    // 4 — receipt BEFORE the side effect (invariant 2). No receipt, no call.
    try {
      await hooks.receipt(sctx, { phase: 'pre' });
    } catch (e) {
      await mark({ status: 'failed', error: { code: 'RECEIPT_UNAVAILABLE', message: e instanceof Error ? e.message : String(e) }, end: true });
      return { kind: 'stop', reason: 'receipt_unavailable', message: `no audit receipt could be written for ${inv.toolId}; it was not called` };
    }
    // 5 — compensator capture BEFORE the call (M6). No undo prepared, no call: afterwards the
    // pre-state is gone.
    try {
      await hooks.captureCompensator(sctx, sim);
    } catch (e) {
      await mark({ status: 'failed', error: { code: 'CAPTURE_FAILED', message: e instanceof Error ? e.message : String(e) }, end: true });
      return { kind: 'stop', reason: 'infrastructure', message: e instanceof Error ? e.message : `the undo for ${inv.toolId} could not be prepared; it was not called` };
    }
    // The journal says `running` before the provider hears anything. An R0/R1 call made on a
    // best guess carries the assumption on its node, where the blast radius shows it (§5.1).
    await mark({ status: 'running', start: true, attempt: true, ...(effect || assumptions.length ? { effect: { ...(effect ?? {}), ...(assumptions.length ? { assumptions } : {}) } } : {}) });
    if (decl.reversibility !== READ) {
      await store.upsertAction(run.tenantId, { runId: run.id, nodeRowId: row.id, toolId: inv.toolId, argsDigest: d, taint: inv.gate!.argTaint, reversibility: decl.reversibility, state: 'PLANNED', riskScore: policy.riskScore ?? null, riskTier: policy.riskTier ?? null });
    }
    try {
      return await this.call(row, inv, decl, sctx, d, assumptions, sim);
    } catch (e) {
      throw new CalledError(e);
    }
  }

  /**
   * Edit and requeue (M6 §5.5): a person changed the CONTENT during a hold of this call. The
   * program still computes the original arguments (the journal checks those); what is decided
   * and sent is the edited version, under its own key — a new policy decision, a new hold.
   */
  private async effective(inv: ToolInvocation, seq: number, d0: string): Promise<{ inv: ToolInvocation; d: string }> {
    const { run, version, deps } = this.cfg;
    const holdId = run.checkpoint.edits?.[`v${version}:${seq}:${d0}`];
    if (!holdId || !deps.reversibility) return { inv, d: d0 };
    const { editedArgs } = await deps.reversibility.deps.store.openArtifact(run.tenantId, holdId);
    return editedArgs ? { inv: { ...inv, args: editedArgs }, d: argsDigest(editedArgs) } : { inv, d: d0 };
  }

  /** A row left `running` by a process that died mid-call. */
  private async recover(row: JournalRow, inv0: ToolInvocation, decl: ToolDeclarationRecord, seq: number, d0: string, _assumptions: string[]): Promise<CallOutcome> {
    const { run, deps } = this.cfg;
    const { inv, d } = await this.effective(inv0, seq, d0);
    const sctx = this.stepContext(inv, decl, seq, row.id);
    if (decl.reversibility === READ || decl.idempotency === 'KEYED' || decl.idempotency === 'NATIVE') {
      deps.log.warn({ run_id: run.id, tool_id: inv.toolId, call_seq: seq }, 'recovering a call that was in flight when the executor stopped');
      return this.call(row, inv, decl, sctx, d);
    }
    await persist(() => deps.store.markNode(run.tenantId, run.id, row.id, { status: 'unknown', error: { code: 'OUTCOME_UNKNOWN', message: 'the executor stopped mid-call; this tool has no idempotency key' }, end: true }));
    const actionId = await persist(() => deps.store.upsertAction(run.tenantId, { runId: run.id, nodeRowId: row.id, toolId: inv.toolId, argsDigest: d, taint: inv.gate!.argTaint, reversibility: decl.reversibility, state: 'UNKNOWN' }));
    await deps.reversibility?.bind(run.tenantId, row.id, 'unknown', actionId).catch((e) => deps.log.error({ err: e, run_id: run.id }, 'could not record the unknown outcome on its compensation'));
    await deps.hooks.receipt(sctx, { phase: 'post', outcome: 'unknown' }).catch(() => undefined);
    return { kind: 'stop', reason: 'unknown_outcome', message: `${inv.toolId} may or may not have happened: the executor stopped mid-call and the tool cannot be safely retried` };
  }

  private async call(row: JournalRow, inv: ToolInvocation, decl: ToolDeclarationRecord, sctx: StepContext, d: string, assumptions: string[] = [], sim?: SimulationResult): Promise<CallOutcome> {
    const { run, version, deps } = this.cfg;
    const connectorId = this.binding(inv.toolId, decl);
    let result: ToolResult<unknown>;
    if (!connectorId) {
      result = { ok: false, error: { code: 'CONNECTOR_UNAVAILABLE', message: `no ${decl.connectorKind} connector is bound to this run` } };
    } else {
      try {
        // Idempotency key = run + (program version, call_seq): stable across restarts, distinct
        // across replans and across the invocations of one call site inside `map`.
        result = await deps.invoker.execute({ tenantId: run.tenantId, connectorId, toolId: inv.toolId, args: inv.args, runId: run.id, nodeId: `v${version}.${sctx.callSeq}` });
      } catch (e) {
        result = { ok: false, error: { code: 'PROVIDER_ERROR', message: e instanceof Error ? e.message : 'connector failure' } };
      }
    }
    const nonRead = decl.reversibility !== READ;
    const rev = deps.reversibility;
    const action = async (state: 'COMMITTED' | 'FAILED' | 'UNKNOWN', effect?: unknown): Promise<string | null> => {
      if (!nonRead) return null;
      const id = await persist(() => deps.store.upsertAction(run.tenantId, { runId: run.id, nodeRowId: row.id, toolId: inv.toolId, argsDigest: d, taint: inv.gate!.argTaint, reversibility: decl.reversibility, state, effect }));
      // The compensation learns what happened: the TTL starts and the saga order is fixed.
      // A failure that does not PROVE nothing happened keeps the undo available (outcome unknown).
      const outcome = state === 'UNKNOWN' || (!result.ok && !PROVABLY_NOT_APPLIED.has(result.error.code)) ? 'unknown' : result;
      if (rev) await persist(() => rev.bind(run.tenantId, row.id, outcome, id));
      return id;
    };
    const mark = (patch: Parameters<RunStore['markNode']>[3]) => persist(() => deps.store.markNode(run.tenantId, run.id, row.id, patch));

    if (!result.ok) {
      if (result.error.code === 'OUTCOME_UNKNOWN') {
        await mark({ status: 'unknown', error: result.error, end: true });
        await action('UNKNOWN');
        await deps.hooks.receipt(sctx, { phase: 'post', outcome: 'unknown', error: result.error.code }).catch(() => undefined);
        return { kind: 'stop', reason: 'unknown_outcome', message: `${inv.toolId}: ${result.error.message}` };
      }
      await mark({ status: 'failed', error: result.error, end: true });
      await action('FAILED');
      await deps.hooks.receipt(sctx, { phase: 'post', outcome: 'failed', error: result.error.code }).catch((e) => deps.log.error({ err: e, run_id: run.id }, 'post-receipt failed'));
      return { kind: 'result', result };
    }
    const effect = summarize(result);
    await mark({ status: 'done', result, effect: { ...effect, ...(assumptions.length ? { assumptions } : {}) }, end: true });
    const actionId = await action('COMMITTED', effect);
    // 6 — divergence (M6 §5.7): the actual effect against what was simulated and approved.
    const div = rev && sim ? await rev.diverged(sctx, sim, result.effect, actionId).catch((e) => (deps.log.error({ err: e, run_id: run.id }, 'divergence check failed'), { abort: false, message: '' })) : { abort: false, message: '' };
    // 7 — verify (M9), then 8 — the post receipt (M7)
    const v = await deps.hooks.verify(sctx, { effect: result.effect });
    await deps.hooks.receipt(sctx, { phase: 'post', outcome: 'committed', effect }).catch((e) => deps.log.error({ err: e, run_id: run.id }, 'post-receipt failed'));
    if (div.abort) return { kind: 'stop', reason: 'divergence', message: `${div.message}: the run was stopped and what it did is being undone` };
    if (!v.ok) return { kind: 'stop', reason: 'verify_failure', message: `verification failed for ${inv.toolId}: ${v.reason}` };
    return { kind: 'result', result };
  }
}

/** Wraps an error thrown AFTER the journal said `running`: it must fail the step, not be swallowed. */
class CalledError extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

export type { DurableContext };
