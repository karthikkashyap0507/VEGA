import type { Effect, ToolDeclarationRecord } from '@vega/contracts';

/**
 * THE SIX EXTENSION POINTS — docs/module4.md §5.3, §5.6. Every consequential step runs them in
 * THIS order, and two orderings are load-bearing and must never be "optimized":
 *
 *   policyHook → simulateHook → preVerify → approvalGate → receiptHook('pre') → captureCompensator
 *     → [the tool call, through the M3 gate and the M2 runtime] → verifyHook → receiptHook('post')
 *
 *   · receipt BEFORE the side effect (PROJECT.md invariant 2): an effect without an audit entry
 *     is unprovable
 *   · compensator capture BEFORE the call (M6): afterwards the pre-state is gone
 *
 * Seam-only rule: where a later module owns the logic, this module ships the typed interface
 * and a permissive default that WARNS ON EVERY CALL. Never an implicit `true`. A deployment on
 * defaults is ungoverned, and its logs say so step by step.
 *
 * The policy hook has no default any more (Module 5): whoever wires the hooks supplies the
 * policy engine, and there is no code path in which an action skips it. Verification (Module 9)
 * is the same: `preVerify` runs after simulate, `verify` after the call, and both are required.
 */

/** Everything a hook may need — over-provided on purpose (module4.md §15). */
export interface StepContext {
  tenantId: string;
  runId: string;
  programVersion: number;
  /** DSL node id (stable per call site) and the Nth call of this program version. */
  nodeId: string;
  callSeq: number;
  /** The journal row (task_nodes.id) of this call: what evaluations and receipts point at. */
  nodeRowId: string;
  /** How the run started (chat, schedule, webhook, api, test). */
  trigger: string;
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

/** One step of a decision's human-readable reason chain (module5.md §5.5). */
export interface ReasonStep {
  step: string;
  detail: string;
  id?: string;
  version?: number;
  citation?: string | null;
}

/**
 * What the policy engine (Module 5) decided for one step.
 *   ALLOW_WITH_HOLD        run after `holdWindowMs` unless revoked (released early on request)
 *   REQUIRE_APPROVAL       one approver holding `approverRole`
 *   REQUIRE_DUAL_APPROVAL  two DISTINCT approvers; with `separationOfDuties`, neither the requester
 *   DENY                   not at all; `failClosed` = the engine could not decide (an outage)
 *   HOLD                   held until someone releases it (no window)
 */
export type PolicyDecision = {
  decision: 'ALLOW' | 'ALLOW_WITH_HOLD' | 'HOLD' | 'REQUIRE_APPROVAL' | 'REQUIRE_DUAL_APPROVAL' | 'DENY';
  reason?: string;
  riskScore?: number;
  riskTier?: string;
  policyIds?: string[];
  approverRole?: string | null;
  holdWindowMs?: number | null;
  separationOfDuties?: boolean;
  chain?: ReasonStep[];
  evaluationId?: string;
  failClosed?: boolean;
  /**
   * Module 7: what the decision was made ON — recorded in the receipt's replay tape so the
   * evidence plane can re-run the risk function and the policy evaluation without this database.
   */
  inputs?: DecisionInputs;
};

export interface DecisionInputs {
  risk: Record<string, unknown> | null;
  weights: Record<string, unknown> | null;
  policy: Record<string, unknown> | null;
  preset: string | null;
  presetVersion: number | null;
  bundleVersion: number | null;
  bundleRevision: string | null;
  matches: Array<{ id: string; version: number }>;
  decidedBy: string | null;
  factors?: Record<string, number> | undefined;
}

/**
 * Module 7 — what the executor knows at a receipt that the step context does not: the decision
 * actually applied (with the gate folded in), the approval and hold, the replay tape and, after
 * the call, the result. The receipt hook turns it into the §5.1 receipt and its content.
 */
export interface ReceiptRecord {
  policy?: PolicyDecision | undefined;
  /** What the policy ENGINE decided, before the M3 gate's REQUIRE_APPROVAL was folded in. */
  engineDecision?: PolicyDecision['decision'] | undefined;
  approval?: { required: boolean; granted: boolean; approverRole: string | null; by: string[]; evidenceDigest?: string | null; requestId?: string | null } | null | undefined;
  hold?: { windowMs: number; released: boolean; revoked: boolean } | null | undefined;
  /** The arguments the program computed, when a person edited what was sent (M6 edit-and-requeue). */
  programArgs?: Record<string, unknown> | undefined;
  program?: { digest: string | null; modelId: string | null } | undefined;
  /** Pre only: everything a DRY re-execution up to this call reads. */
  tape?: ReceiptTape | undefined;
  /** Post only: the tool's full result. */
  result?: unknown;
  /** Module 9: the verification of this phase (pre: the six checks; post: what actually happened). */
  verification?: VerificationOutcome | undefined;
}

export interface ReceiptTape {
  program: { version: number; digest: string; ast: unknown; modelId: string; now: string };
  inputs: Record<string, { data: unknown; taint: 'TRUSTED' | 'ORG' | 'UNTRUSTED'; sourceId?: string }>;
  maxCollection: number;
  declarations: Array<[string, unknown]>;
  calls: Array<{ seq: number; toolId: string; args: unknown; result: unknown }>;
  extractions: Array<{ seq: number; schema: string; value?: unknown; error?: string }>;
  lookups: Array<{ seq: number; registry: 'directory' | 'contacts'; key: string; entity: unknown }>;
}
export type SimulationResult = { ok: true; effect: Effect<unknown> } | { ok: false; reason: string };
export type ApprovalDecision = { decision: 'PROCEED' } | { decision: 'WAIT'; reason: string };
export type Receipt = { phase: 'pre' | 'post'; outcome?: 'committed' | 'failed' | 'unknown'; effect?: unknown; error?: string; record?: ReceiptRecord };
export type VerifyResult = { ok: true; verification?: VerificationOutcome } | { ok: false; reason: string; compensate: boolean; verification?: VerificationOutcome };

/**
 * Module 9 — what the verification engine is given about a step. `reads` is what the run had
 * read before this call (the tape), each with the taint its tool declares: the evidence a
 * generated claim must be found in.
 */
export interface VerificationInput {
  sim: SimulationResult;
  /** The decision actually applied (gate folded in), and what the engine alone said. */
  policy: PolicyDecision;
  engineDecision: PolicyDecision['decision'];
  /** A person already approved this exact call (with its packet in front of them). */
  approved: boolean;
  objective: string;
  reads: Array<{ id: string; value: unknown; taint: 'TRUSTED' | 'ORG' | 'UNTRUSTED' }>;
}

export type VerificationVerdict = 'PASS' | 'WARN' | 'ESCALATE' | 'ABORT' | 'COMPENSATE';

/** Module 9 — one verification, as the executor, the receipt and the approval packet see it. */
export interface VerificationOutcome {
  id: string | null;
  phase: 'pre_commit' | 'post_commit';
  outcome: VerificationVerdict;
  reason: string | null;
  checks: Array<{ check: string; outcome: string; detail: string }>;
  /** Groundedness findings a person should see (UNSUPPORTED / CONTRADICTED), for the M8 packet. */
  unsupportedClaims: Array<{ text: string; reason: string }>;
}

export interface Hooks {
  /** Module 5. Every consequential step: ALLOW, hold, approval (single or dual), or DENY. */
  policy(ctx: StepContext): Promise<PolicyDecision>;
  /** Module 6. Blast radius. */
  simulate(ctx: StepContext): Promise<SimulationResult>;
  /** Module 8. WAIT pauses the run on a signal. `approved` = a human already approved this node. */
  approval(ctx: StepContext, sim: SimulationResult, policy: PolicyDecision, approved: boolean): Promise<ApprovalDecision>;
  /** Module 7. MUST be durable before the side effect. */
  receipt(ctx: StepContext, receipt: Receipt): Promise<void>;
  /** Module 6. MUST run before the call. */
  captureCompensator(ctx: StepContext, sim: SimulationResult): Promise<{ captured: boolean; ref?: string }>;
  /**
   * Module 9, pre-commit: the six checks after simulation, before approval. ABORT stops the step
   * (the run replans); ESCALATE routes it to a person (folded into the decision as REQUIRE_APPROVAL).
   */
  preVerify(ctx: StepContext, input: VerificationInput): Promise<VerificationOutcome>;
  /** Module 9, post-commit: what actually happened against what was approved. May trigger compensation. */
  verify(ctx: StepContext, result: { effect: Effect<unknown>; input?: VerificationInput }): Promise<VerifyResult>;
}

export interface WarnSink {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/**
 * The permissive defaults for the hooks later modules own. Each one logs, on every call, which
 * module is missing. `simulate` really simulates (via the injected function) — M6 adds
 * aggregation, not the call. `policy` is REQUIRED: the Module 5 engine, never a default.
 */
export function defaultHooks(
  log: WarnSink,
  simulate: (ctx: StepContext) => Promise<SimulationResult>,
  recordEvent: (ctx: StepContext, r: Receipt) => Promise<void>,
  policy: (ctx: StepContext) => Promise<PolicyDecision>,
  verification: Pick<Hooks, 'preVerify' | 'verify'>,
): Hooks {
  const warn = (hook: string, module: string, ctx: StepContext) =>
    log.warn({ hook, module, run_id: ctx.runId, node_id: ctx.nodeId, tool_id: ctx.toolId, ungoverned: true }, `${hook}: ${module} not installed — step is UNGOVERNED by it`);
  return {
    policy,
    async simulate(ctx) {
      return simulate(ctx);
    },
    // Module 8 is installed: this gate only says WAIT or PROCEED. Who decides, what they are shown,
    // when it expires and what happens then is the approval request the run workflow opens
    // (services/execution/src/approvals) — the decision is committed on that row, not here.
    async approval(_ctx, _sim, decided, approved) {
      if ((decided.decision === 'REQUIRE_APPROVAL' || decided.decision === 'REQUIRE_DUAL_APPROVAL') && !approved) return { decision: 'WAIT', reason: decided.reason ?? 'policy requires approval' };
      return { decision: 'PROCEED' };
    },
    // Module 7 is installed: the receipt goes to the signed chain when the caller's recordEvent
    // appends it there (services/execution executionHooks), and THROWS when it cannot — so the
    // executor never calls a tool whose receipt was not committed (invariant 2).
    async receipt(ctx, r) {
      await recordEvent(ctx, r);
    },
    async captureCompensator(ctx) {
      if (ctx.tool.reversibility !== 'R0') warn('captureCompensator', 'compensation engine (Module 6)', ctx);
      return { captured: false };
    },
    // Module 9 is installed: like policy, verification has no permissive default — whoever wires
    // the hooks supplies the engine (services/execution/src/verification).
    preVerify: (ctx, input) => verification.preVerify(ctx, input),
    verify: (ctx, result) => verification.verify(ctx, result),
  };
}

/** The order, as data, so tests can assert it and a refactor cannot silently reorder it. */
export const HOOK_ORDER = ['policy', 'simulate', 'preVerify', 'approval', 'receipt:pre', 'captureCompensator', 'call', 'verify', 'receipt:post'] as const;
