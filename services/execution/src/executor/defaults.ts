import { argsDigest } from '@vega/connector-sdk';
import { schema, withTenant } from '@vega/db';
import { defaultHooks, type Hooks, type PolicyDecision, type Receipt, type SimulationResult, type StepContext } from '@vega/orchestration';
import type { EvidenceAppendClient } from '../evidence-append.js';
import { actionReceipt, programEntry } from '../evidence-receipt.js';
import type { ReversibilityEngine } from '../reversibility/engine.js';
import { VerificationEngine, type VerificationDeps } from '../verification/engine.js';
import type { AutonomyEngine } from '../autonomy/engine.js';
import type { ExecutorLog, ProgramReceipt, ToolInvoker } from './pass.js';

/**
 * The execution plane's wiring of the six extension points (docs/module4.md §5.6).
 *
 *   policy    — REQUIRED: the Module 5 engine (services/execution/src/policy). There is no
 *               default and no code path around it.
 *
 *   simulate  — M2 `simulate()` for anything that is not a read (a read has no effect to predict)
 *   captureCompensator — Module 6: the compensation token, sealed, before the call; a capture
 *               that fails stops the call (the pre-state would be gone afterwards)
 *   receipt   — Module 7: the §5.1 receipt, appended to the signed chain (`action.pre` before
 *               the call, `action.post` after) with the content it commits to, and mirrored to
 *               platform_events.
 *   preVerify / verify — Module 9: the six checks before approval, and what actually happened
 *               after the call (services/execution/src/verification). Always installed. A failed append THROWS, and the executor then does not make the
 *               call: "no side effect occurs before its audit entry is committed" (invariant 2).
 */
export function executionHooks(opts: {
  log: ExecutorLog;
  invoker: ToolInvoker;
  evidence?: EvidenceAppendClient | undefined;
  requireEvidence: boolean;
  policy: (ctx: StepContext) => Promise<PolicyDecision>;
  /** Module 6: capture the compensation BEFORE the call. Without it the hook warns (ungoverned). */
  reversibility?: ReversibilityEngine | undefined;
  /** Module 9: the verification engine; built from `classify`/`kb` when not given. */
  verification?: VerificationEngine | undefined;
  classify?: VerificationDeps['classify'];
  kb?: VerificationDeps['kb'];
  contacts?: VerificationDeps['contacts'];
  /** Module 10: the autonomy ladder. Absent: nothing is added to policy's own decision. */
  autonomy?: AutonomyEngine | undefined;
}): Hooks {
  const simulate = async (ctx: StepContext): Promise<SimulationResult> => {
    if (ctx.tool.reversibility === 'R0') {
      return { ok: true, effect: { summary: `read with ${ctx.toolId}`, fidelity: 'DERIVED', externalRecipients: [], recordsAffected: [], detail: null } };
    }
    if (!ctx.connectorId) return { ok: false, reason: 'no connector bound' };
    const r = await opts.invoker.simulate({ tenantId: ctx.tenantId, connectorId: ctx.connectorId, toolId: ctx.toolId, args: ctx.args, runId: ctx.runId, nodeId: `v${ctx.programVersion}.${ctx.callSeq}` });
    return r.ok ? { ok: true, effect: r.effect } : { ok: false, reason: `${r.error.code}: ${r.error.message}` };
  };

  const recordEvent = async (ctx: StepContext, r: Receipt) => {
    if (opts.evidence) {
      const { payload, content } = actionReceipt(ctx, r);
      await opts.evidence.append({ tenantId: ctx.tenantId, kind: `action.${r.phase}`, payload: payload as unknown as Record<string, unknown>, content: content.list() });
    } else if (opts.requireEvidence) {
      throw new Error('the evidence plane is not configured: no receipt, no action');
    } else {
      opts.log.warn({ hook: 'receiptHook', run_id: ctx.runId, node_id: ctx.nodeId, tool_id: ctx.toolId, ungoverned: true }, 'receiptHook: no evidence plane configured — this action has NO signed receipt');
    }
    // The tenant's own event stream (webhooks, the run timeline) keeps its short form.
    const event = {
      runId: ctx.runId,
      programVersion: ctx.programVersion,
      callSeq: ctx.callSeq,
      nodeId: ctx.nodeId,
      toolId: ctx.toolId,
      argsDigest: argsDigest(ctx.args),
      argTaint: ctx.argTaint,
      reversibility: ctx.tool.reversibility,
      egressClass: ctx.tool.egressClass,
      principalUserId: ctx.principalUserId,
      agentId: ctx.agentId,
      agentVersion: ctx.agentVersion,
      phase: r.phase,
      ...(r.outcome ? { outcome: r.outcome } : {}),
      ...(r.error ? { error: r.error } : {}),
    };
    await withTenant(ctx.tenantId, (db) => db.insert(schema.platformEvents).values({ tenantId: ctx.tenantId, actorId: null, kind: `action.receipt.${r.phase}`, payload: event }));
  };

  const verifier = opts.verification ?? new VerificationEngine({ log: opts.log, classify: opts.classify, kb: opts.kb, contacts: opts.contacts });
  const hooks = defaultHooks(opts.log, simulate, recordEvent, opts.policy, { preVerify: (ctx, i) => verifier.preVerify(ctx, i), verify: (ctx, r) => verifier.verify(ctx, r) }, opts.autonomy ? (ctx, decided, extra) => opts.autonomy!.fold(ctx, decided, extra) : undefined);
  const rev = opts.reversibility;
  return rev ? { ...hooks, captureCompensator: (ctx) => rev.arm(ctx) } : hooks;
}

/** `run.program`: a plan version, recorded before its first call (ExecutorDeps.programReceipt). */
export function programReceipt(evidence: EvidenceAppendClient | undefined): ((p: ProgramReceipt) => Promise<void>) | undefined {
  if (!evidence) return undefined;
  return async (p) => {
    const { payload, content } = programEntry(p);
    await evidence.append({ tenantId: p.tenantId, kind: 'run.program', payload, content: content.list() });
  };
}
