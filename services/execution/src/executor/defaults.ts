import { argsDigest } from '@vega/connector-sdk';
import { schema, withTenant } from '@vega/db';
import { defaultHooks, type Hooks, type PolicyDecision, type Receipt, type SimulationResult, type StepContext } from '@vega/orchestration';
import type { EvidenceAppendClient } from '../evidence-append.js';
import type { ExecutorLog, ToolInvoker } from './pass.js';

/**
 * The execution plane's wiring of the six extension points (docs/module4.md §5.6).
 *
 *   policy    — REQUIRED: the Module 5 engine (services/execution/src/policy). There is no
 *               default and no code path around it.
 *
 *   simulate  — M2 `simulate()` for anything that is not a read (a read has no effect to predict)
 *   receipt   — platform_events AND an append to the evidence plane when one is configured.
 *               A failed append THROWS, and the executor then does not make the call:
 *               "no side effect occurs before its audit entry is committed" (invariant 2).
 */
export function executionHooks(opts: {
  log: ExecutorLog;
  invoker: ToolInvoker;
  evidence?: EvidenceAppendClient | undefined;
  requireEvidence: boolean;
  policy: (ctx: StepContext) => Promise<PolicyDecision>;
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
    const payload = {
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
    if (opts.evidence) await opts.evidence.append({ tenantId: ctx.tenantId, kind: `action.receipt.${r.phase}`, payload });
    else if (opts.requireEvidence) throw new Error('the evidence plane is not configured: no receipt, no action');
    await withTenant(ctx.tenantId, (db) => db.insert(schema.platformEvents).values({ tenantId: ctx.tenantId, actorId: null, kind: `action.receipt.${r.phase}`, payload }));
  };

  return defaultHooks(opts.log, simulate, recordEvent, opts.policy);
}
