import { TERMINAL_RUN_STATUSES, type RunStatus, type ToolDeclarationRecord } from '@vega/contracts';
import { callsOf, type Program } from '@vega/dsl';
import { evaluate, type RunContext } from '@vega/interpreter';
import type { DurableContext } from '@vega/orchestration';
import { TransitionError, type LoadedRun } from '@vega/runs';
import { DurablePass, type CommittedFact, type ExecutorDeps, type PendingAction } from './pass.js';

/**
 * THE RUN WORKFLOW — one durable workflow per run (docs/module4.md §5.3; engine: DBOS, D-13).
 *
 * The body is a loop of interpreter passes over the current program version. A pass ends in
 * one of: completed · suspended (approval, clarification, hold, credential) · failed. Suspension
 * is a durable wait on a message; failure is classified into a replan (§5.5), an escalation
 * (NEEDS_ATTENTION), or the end of the run. Planning itself happens in the control plane: the
 * workflow asks for a replan, and the next program version arrives as a message.
 *
 * Everything here must be deterministic apart from step results and messages: DBOS replays the
 * function from the top after a restart and returns recorded step outputs.
 */

export const RUN_WORKFLOW = 'vega.run';
export const MAX_REPLANS = 3;
const MAX_PASSES = 200;
const DAY = 86_400;
const PLAN_TIMEOUT_S = 3_600;

export const TOPICS = { decision: 'decision', input: 'input', program: 'program', resume: 'resume' } as const;
export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

export interface RunArgs {
  tenantId: string;
  runId: string;
}
export interface RunOutcome {
  status: RunStatus;
  reason?: string;
}
export type DecisionMessage = { key: string; decision: 'approve' | 'reject'; by: string; note?: string };
export type InputMessage = { field: string; choice: string; by: string };
export type ProgramMessage = { version: number } | { abort: string };
export type ResumeMessage = { action?: 'resume' | 'release' | 'revoke'; by?: string };

export function expirySeconds(expiry: string): number {
  const m = /^(\d+)([mhd])$/.exec(expiry);
  if (!m) return 4 * 3_600;
  return Number(m[1]) * (m[2] === 'm' ? 60 : m[2] === 'h' ? 3_600 : DAY);
}

/** Names bound before the program runs: the objective and resolved entities TRUSTED, a trigger payload UNTRUSTED. */
export function runInputs(run: Pick<LoadedRun, 'id' | 'objective' | 'checkpoint'>): NonNullable<RunContext['inputs']> {
  const inputs: NonNullable<RunContext['inputs']> = { objective: { data: run.objective.objective, taint: 'TRUSTED' } };
  for (const e of run.objective.entities) {
    inputs[e.binding] = { data: { id: e.resolvedId, type: e.type, name: e.name ?? e.raw, email: e.email ?? null }, taint: 'TRUSTED', sourceId: `entity:${e.binding}` };
  }
  if (run.checkpoint.triggerPayload !== undefined) inputs['trigger_payload'] = { data: run.checkpoint.triggerPayload, taint: 'UNTRUSTED', sourceId: `trigger:${run.id}` };
  return inputs;
}

const FAILURE_REPLAN: Record<string, string> = { CONFLICT: 'precondition_invalid', NOT_FOUND: 'precondition_invalid', VALIDATION: 'precondition_invalid' };

export function runWorkflow(deps: ExecutorDeps) {
  return async (ctx: DurableContext, args: RunArgs): Promise<RunOutcome> => {
    const { tenantId, runId } = args;
    const memo = new Map<string, unknown>();
    const approvals = new Set<string>();
    const released = new Set<string>();

    /** A status change is a step: recorded once, replayed rather than repeated. */
    const transition = (name: string, to: RunStatus, opts: Parameters<ExecutorDeps['store']['setStatus']>[3] = {}) =>
      ctx.step(
        name,
        async () => {
          try {
            await deps.store.setStatus(tenantId, runId, to, opts);
            return { ok: true as const };
          } catch (e) {
            if (e instanceof TransitionError) return { ok: false as const, from: e.from };
            throw e;
          }
        },
        { retries: 5 },
      );
    const end = async (name: string, to: RunStatus, reason: string, extra: { error?: unknown; actorId?: string | null } = {}): Promise<RunOutcome> => {
      await ctx.step(`${name}:skip`, () => deps.store.skipPending(tenantId, runId), { retries: 5 });
      const t = await transition(name, to, { reason, ...(extra.error !== undefined ? { error: extra.error } : {}), ...(extra.actorId !== undefined ? { actorId: extra.actorId } : {}) });
      return t.ok ? { status: to, reason } : { status: t.from };
    };

    for (let passNo = 1; passNo <= MAX_PASSES; passNo++) {
      const run = await ctx.step(`load:${passNo}`, () => deps.store.load(tenantId, runId), { retries: 5 });
      if (!run) return { status: 'FAILED', reason: 'run not found' };
      if (TERMINAL_RUN_STATUSES.has(run.status)) return { status: run.status };
      for (const a of run.checkpoint.approvals) approvals.add(a);
      for (const k of run.checkpoint.released ?? []) released.add(k);
      const version = run.programVersion;
      const prog = await ctx.step(
        `program:v${version}:p${passNo}`,
        async () => {
          const p = await deps.store.program(tenantId, runId, version);
          return p ? { ast: p.ast, modelId: p.modelId, createdAt: p.createdAt.toISOString() } : null;
        },
        { retries: 5 },
      );
      if (!prog) return end(`noprogram:${passNo}`, 'FAILED', `no program version ${version} for this run`);
      const program = prog.ast as Program;
      const decls = await ctx.step(
        `decls:v${version}:p${passNo}`,
        async () => {
          const out: Array<[string, ToolDeclarationRecord]> = [];
          for (const c of callsOf(program)) {
            if (out.some(([id]) => id === c.tool)) continue;
            const d = await deps.declarations.get(tenantId, c.tool);
            if (d) out.push([c.tool, d]);
          }
          return out;
        },
        { retries: 3 },
      );
      const committed: CommittedFact[] =
        version > 1
          ? await ctx.step(`committed:v${version}:p${passNo}`, async () => (await deps.store.committed(tenantId, runId)).filter((c) => c.version < version), { retries: 5 })
          : [];

      const enter = await transition(`executing:${passNo}`, 'EXECUTING', { reason: null, pending: null });
      if (!enter.ok) return { status: enter.from };

      const pass = new DurablePass({ ctx, deps, run, version, passNo, approvals, released, committed, memo });
      const result = await evaluate(
        { tools: pass, declarations: deps.declarations, extractor: pass.extractor, entities: pass.entities, recorder: pass.recorder, schemas: deps.schemas, ...(deps.pager ? { pager: deps.pager } : {}) },
        program,
        { tenantId, runId, modelId: prog.modelId, mode: 'execute', now: prog.createdAt, delegateApproval: true, maxCollection: run.spec.limits.maxFanout, inputs: runInputs(run) },
        new Map(decls),
      );
      await ctx.step(`flush:${passNo}`, () => pass.recorder.flush(), { retries: 3 });

      // ------------------------------------------------------------ the pass is over
      if (result.status === 'completed') {
        await ctx.step(`complete:${passNo}:skip`, () => deps.store.skipPending(tenantId, runId), { retries: 5 });
        const emits = result.emits.map((e) => ({ data: e.data, taint: e.taint, dataTaint: e.dataTaint, sourceIds: [...e.sourceIds] }));
        const t = await transition(`completed:${passNo}`, 'COMPLETED', { result: { emits, calls: result.calls.length, traceDigest: result.traceDigest, programVersion: version } });
        return t.ok ? { status: 'COMPLETED' } : { status: t.from };
      }

      const suspension = pass.suspension;
      if (result.status === 'awaiting_approval' && suspension) {
        const pending = suspension.pending;
        const t = await transition(`approval:${passNo}`, 'AWAITING_APPROVAL', { reason: pending.reason, pending });
        if (!t.ok) return { status: t.from };
        let decision: DecisionMessage | null = null;
        // A decision names the exact call it approves (version, call, argument digest). Anything
        // else is stale — e.g. a double-click on an approval for an earlier plan — and ignored.
        // A dual approval (Module 5) needs two DISTINCT approvers, and under separation of duties
        // neither may be the person the run acts for. The control plane refuses those first; this
        // is the executor's own check, because the approval is what lets the action happen.
        const required = pending.approvalsRequired ?? 1;
        const sod = pending.policy?.separationOfDuties === true;
        const approvers: string[] = [...(pending.approvedBy ?? [])];
        for (let i = 0; i < 40 && !decision; i++) {
          const m = await ctx.recv<DecisionMessage>(TOPICS.decision, expirySeconds(run.spec.escalation.expiry));
          if (!m) break;
          if (m.key !== pending.key) continue;
          if (m.decision === 'reject') {
            decision = m;
            break;
          }
          if (required > 1 && ((sod && m.by === run.principalUserId) || approvers.includes(m.by))) {
            deps.log.warn({ run_id: runId, by: m.by }, 'ignored an approval: the same approver twice, or the requester under separation of duties');
            continue;
          }
          approvers.push(m.by);
          if (approvers.length >= required) {
            decision = m;
            break;
          }
          const partial = [...approvers];
          const t2 = await transition(`approval:${passNo}:${partial.length}`, 'AWAITING_APPROVAL', { reason: `${partial.length} of ${required} approvals`, pending: { ...pending, approvedBy: partial } });
          if (!t2.ok) return { status: t2.from };
        }
        if (!decision || decision.decision === 'reject') {
          if (pending.nodeRowId) {
            await ctx.step(`reject:${passNo}`, () =>
              deps.store.markNode(tenantId, runId, pending.nodeRowId!, { status: 'skipped', error: decision ? { code: 'REJECTED', by: decision.by, note: decision.note ?? null } : { code: 'APPROVAL_EXPIRED' }, end: true }),
            );
          }
          const reason = decision ? `rejected by approver${decision.note ? `: ${decision.note}` : ''}` : `approval expired after ${run.spec.escalation.expiry} (fallback ${run.spec.escalation.fallback})`;
          return end(`rejected:${passNo}`, 'CANCELLED', reason, { actorId: decision?.by ?? null });
        }
        approvals.add(decision.key);
        const key = decision.key;
        const by = decision.by;
        await ctx.step(`approved:${passNo}`, () => deps.store.updateCheckpoint(tenantId, runId, (cp) => ({ ...cp, approvals: [...new Set([...cp.approvals, key])] })), { retries: 5 });
        deps.log.info({ run_id: runId, key, by }, 'action approved; resuming');
        continue;
      }

      if (result.status === 'held' && suspension) {
        const pending = suspension.pending;
        const t = await transition(`held:${passNo}`, 'HELD', { reason: pending.reason, pending });
        if (!t.ok) return { status: t.from };
        if (pending.kind === 'hold' && pending.key && pending.holdWindowMs) {
          // A policy hold (ALLOW_WITH_HOLD): the window is a durable wait. It ends by itself —
          // the action then runs — or early: `release` runs it now, `revoke` cancels it.
          const key = pending.key;
          const m = await ctx.recv<ResumeMessage>(TOPICS.resume, Math.ceil(pending.holdWindowMs / 1000));
          if (m?.action === 'revoke') {
            if (pending.nodeRowId) {
              await ctx.step(`revoke:${passNo}`, () => deps.store.markNode(tenantId, runId, pending.nodeRowId!, { status: 'skipped', error: { code: 'REVOKED', by: m.by ?? null }, end: true }), { retries: 5 });
            }
            return end(`revoked:${passNo}`, 'CANCELLED', `revoked during its hold window (${pending.toolId ?? 'action'} never ran)`, { actorId: m.by ?? null });
          }
          released.add(key);
          await ctx.step(`released:${passNo}`, () => deps.store.updateCheckpoint(tenantId, runId, (cp) => ({ ...cp, released: [...new Set([...(cp.released ?? []), key])] })), { retries: 5 });
          deps.log.info({ run_id: runId, key, by: m?.by ?? null, early: Boolean(m) }, m ? 'hold released early' : 'hold window passed; releasing');
          continue;
        }
        const m = await ctx.recv<ResumeMessage>(TOPICS.resume, 7 * DAY);
        if (!m) return end(`heldexpired:${passNo}`, 'FAILED', 'held for 7 days without release');
        if (m.action === 'revoke') return end(`revoked:${passNo}`, 'CANCELLED', 'revoked while held', { actorId: m.by ?? null });
        // A policy HOLD without a window runs once someone releases it; a credential hold simply
        // resumes (the next pass checks the fresh grant).
        if (pending.kind === 'hold' && pending.key) {
          const key = pending.key;
          released.add(key);
          await ctx.step(`released:${passNo}`, () => deps.store.updateCheckpoint(tenantId, runId, (cp) => ({ ...cp, released: [...new Set([...(cp.released ?? []), key])] })), { retries: 5 });
        }
        continue;
      }

      const replan = async (reason: string, detail: Record<string, unknown>, fromStatus: 'EXECUTING' | 'AWAITING_INPUT' = 'EXECUTING'): Promise<RunOutcome | null> => {
        if (run.replanCount >= MAX_REPLANS) return end(`replanlimit:${passNo}`, 'FAILED', `replan limit (${MAX_REPLANS}) reached; last cause: ${reason}`, { error: detail });
        await ctx.step(`replan:${passNo}`, () => deps.store.requestReplan(tenantId, runId, { fromVersion: version, fromStep: pass.callSeq, reason, detail }), { retries: 5 });
        const pending: PendingAction = { kind: 'replan', reason };
        const t = await transition(`replanning:${passNo}`, 'REPLANNING', { reason: `replanning: ${reason}`, pending: { ...pending, detail, fromVersion: version, from: fromStatus } });
        if (!t.ok) return { status: t.from };
        // Only a NEWER version wakes the run: a duplicate delivery of an older plan's message
        // (the coordinator re-signals until it sees the run move) is consumed and ignored.
        for (let i = 0; i < 20; i++) {
          const m = await ctx.recv<ProgramMessage>(TOPICS.program, PLAN_TIMEOUT_S);
          if (!m) return end(`noplan:${passNo}`, 'FAILED', 'no new plan arrived within an hour');
          if ('abort' in m) return { status: 'PLAN_REJECTED', reason: m.abort };
          if (m.version > version) return null;
        }
        return end(`noplan:${passNo}`, 'FAILED', 'no newer plan arrived');
      };

      if (result.status === 'awaiting_input' && suspension) {
        const t = await transition(`input:${passNo}`, 'AWAITING_INPUT', { reason: suspension.pending.reason, pending: suspension.pending });
        if (!t.ok) return { status: t.from };
        const answer = await ctx.recv<InputMessage>(TOPICS.input, 7 * DAY);
        if (!answer) return end(`inputexpired:${passNo}`, 'FAILED', 'the clarification was not answered within 7 days');
        // The control plane applied the answer to the objective before signalling; C2 replans.
        const out = await replan('clarification', { field: answer.field, choice: answer.choice, by: answer.by }, 'AWAITING_INPUT');
        if (out) return out;
        continue;
      }

      // ------------------------------------------------------------ failures
      if (result.status === 'violated') {
        const v = result.violation;
        return end(`violated:${passNo}`, 'FAILED', `security violation (${v?.kind ?? 'taint'}) on ${v?.toolId ?? 'a tool call'}: refused, recorded and paged`, { error: { violation: v ?? null } });
      }
      const stop = pass.stop;
      if (stop) {
        if (stop.reason === 'unknown_outcome') {
          const t = await transition(`attention:${passNo}`, 'NEEDS_ATTENTION', { reason: stop.message, pending: { kind: 'attention', reason: stop.message } });
          return t.ok ? { status: 'NEEDS_ATTENTION', reason: stop.message } : { status: t.from };
        }
        if (stop.reason === 'policy_denial' || stop.reason === 'verify_failure') {
          const out = await replan(stop.reason, { message: stop.message });
          if (out) return out;
          continue;
        }
        return end(`stopped:${passNo}`, 'FAILED', stop.message, { error: { reason: stop.reason } });
      }
      const failure = pass.failure;
      if (failure) {
        if (failure.code === 'AUTH_EXPIRED' || failure.code === 'CONNECTOR_UNAVAILABLE') {
          // Nothing happened; the run resumes where it stopped once someone re-authorizes.
          const decl = decls.find(([id]) => id === failure.toolId)?.[1];
          const connector = failure.toolId.startsWith('mcp.') ? failure.toolId.split('.').slice(0, 2).join('.') : (decl?.connectorKind ?? 'connector');
          const pending: PendingAction = { kind: 'reauthorize', reason: `${connector} needs to be (re)connected: ${failure.message}`, connector, toolId: failure.toolId };
          const t = await transition(`reauth:${passNo}`, 'AWAITING_INPUT', { reason: pending.reason, pending });
          if (!t.ok) return { status: t.from };
          const m = await ctx.recv<ResumeMessage>(TOPICS.resume, 7 * DAY);
          if (!m) return end(`reauthexpired:${passNo}`, 'FAILED', `${connector} was not re-authorized within 7 days`);
          if (m.action === 'revoke') return end(`reauthcancel:${passNo}`, 'CANCELLED', 'cancelled while waiting for re-authorization', { actorId: m.by ?? null });
          continue;
        }
        const out = await replan(FAILURE_REPLAN[failure.code] ?? 'tool_failure', { ...failure });
        if (out) return out;
        continue;
      }
      if (result.status === 'invalid') {
        const out = await replan('invalid_program', { errors: result.validationErrors ?? [] });
        if (out) return out;
        continue;
      }
      // The program itself went wrong at run time (a bound exceeded, an extraction service down).
      return end(`failed:${passNo}`, 'FAILED', result.error ?? 'the program failed', { error: { error: result.error ?? null } });
    }
    return end('passlimit', 'FAILED', `more than ${MAX_PASSES} passes`);
  };
}
