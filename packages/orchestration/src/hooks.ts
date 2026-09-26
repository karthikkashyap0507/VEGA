import type { Effect, ToolDeclarationRecord } from '@vega/contracts';

/**
 * THE SIX EXTENSION POINTS — docs/module4.md §5.3, §5.6. Every consequential step runs them in
 * THIS order, and two orderings are load-bearing and must never be "optimized":
 *
 *   policyHook → simulateHook → approvalGate → receiptHook('pre') → captureCompensator
 *     → [the tool call, through the M3 gate and the M2 runtime] → verifyHook → receiptHook('post')
 *
 *   · receipt BEFORE the side effect (PROJECT.md invariant 2): an effect without an audit entry
 *     is unprovable
 *   · compensator capture BEFORE the call (M6): afterwards the pre-state is gone
 *
 * Seam-only rule: where a later module owns the logic, this module ships the typed interface
 * and a permissive default that WARNS ON EVERY CALL. Never an implicit `true`. A deployment on
 * defaults is ungoverned, and its logs say so step by step.
 */

/** Everything a hook may need — over-provided on purpose (module4.md §15). */
export interface StepContext {
  tenantId: string;
  runId: string;
  programVersion: number;
  /** DSL node id (stable per call site) and the Nth call of this program version. */
  nodeId: string;
  callSeq: number;
  toolId: string;
  tool: ToolDeclarationRecord;
  args: Record<string, unknown>;
  argTaint: 'TRUSTED' | 'ORG' | 'UNTRUSTED';
  argTaints: Array<{ path: string; taint: string; dataTaint: string; sourceIds: readonly string[] }>;
  principalUserId: string;
  agentId: string;
  agentVersion: number;
  workspaceId: string;
  runCostCents: number;
  connectorId: string | null;
  /** What the M3 gate concluded (violations never reach a hook). */
  gate: { decision: 'PROCEED' | 'REQUIRE_APPROVAL'; reason?: string };
}

export type PolicyDecision = { decision: 'ALLOW' | 'DENY' | 'HOLD' | 'REQUIRE_APPROVAL'; reason?: string; riskScore?: number; riskTier?: string; policyIds?: string[] };
export type SimulationResult = { ok: true; effect: Effect<unknown> } | { ok: false; reason: string };
export type ApprovalDecision = { decision: 'PROCEED' } | { decision: 'WAIT'; reason: string };
export type Receipt = { phase: 'pre' | 'post'; outcome?: 'committed' | 'failed' | 'unknown'; effect?: unknown; error?: string };
export type VerifyResult = { ok: true } | { ok: false; reason: string; compensate: boolean };

export interface Hooks {
  /** Module 5. May DENY, HOLD, or REQUIRE_APPROVAL. */
  policy(ctx: StepContext): Promise<PolicyDecision>;
  /** Module 6. Blast radius. */
  simulate(ctx: StepContext): Promise<SimulationResult>;
  /** Module 8. WAIT pauses the run on a signal. `approved` = a human already approved this node. */
  approval(ctx: StepContext, sim: SimulationResult, policy: PolicyDecision, approved: boolean): Promise<ApprovalDecision>;
  /** Module 7. MUST be durable before the side effect. */
  receipt(ctx: StepContext, receipt: Receipt): Promise<void>;
  /** Module 6. MUST run before the call. */
  captureCompensator(ctx: StepContext, sim: SimulationResult): Promise<{ captured: boolean; ref?: string }>;
  /** Module 9. May trigger compensation. */
  verify(ctx: StepContext, result: { effect: Effect<unknown> }): Promise<VerifyResult>;
}

export interface WarnSink {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The permissive defaults. Each one logs, on every call, which module is missing.
 * `simulate` really simulates (via the injected function) — M6 adds aggregation, not the call.
 */
export function defaultHooks(log: WarnSink, simulate: (ctx: StepContext) => Promise<SimulationResult>, recordEvent: (ctx: StepContext, r: Receipt) => Promise<void>): Hooks {
  const warn = (hook: string, module: string, ctx: StepContext) =>
    log.warn({ hook, module, run_id: ctx.runId, node_id: ctx.nodeId, tool_id: ctx.toolId, ungoverned: true }, `${hook}: ${module} not installed — step is UNGOVERNED by it`);
  return {
    async policy(ctx) {
      warn('policyHook', 'policy engine (Module 5)', ctx);
      return { decision: 'ALLOW', reason: 'default: policy engine not installed' };
    },
    async simulate(ctx) {
      return simulate(ctx);
    },
    async approval(ctx, _sim, policy, approved) {
      warn('approvalGate', 'approval routing (Module 8)', ctx);
      if (policy.decision === 'REQUIRE_APPROVAL' && !approved) return { decision: 'WAIT', reason: policy.reason ?? 'policy requires approval' };
      return { decision: 'PROCEED' };
    },
    async receipt(ctx, r) {
      warn('receiptHook', 'signed audit chain (Module 7)', ctx);
      await recordEvent(ctx, r);
    },
    async captureCompensator(ctx) {
      if (ctx.tool.reversibility !== 'R0') warn('captureCompensator', 'compensation engine (Module 6)', ctx);
      return { captured: false };
    },
    async verify(ctx) {
      if (ctx.tool.reversibility !== 'R0') warn('verifyHook', 'verification (Module 9)', ctx);
      return { ok: true };
    },
  };
}

/** The order, as data, so tests can assert it and a refactor cannot silently reorder it. */
export const HOOK_ORDER = ['policy', 'simulate', 'approval', 'receipt:pre', 'captureCompensator', 'call', 'verify', 'receipt:post'] as const;
