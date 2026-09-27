import { TERMINAL_RUN_STATUSES, type RunStatus, type ToolDeclarationRecord } from '@vega/contracts';
import { callsOf, type Program } from '@vega/dsl';
import { evaluate, type RunContext } from '@vega/interpreter';
import type { DurableContext } from '@vega/orchestration';
import { TransitionError, type LoadedRun } from '@vega/runs';
import { DurablePass, type CommittedFact, type ExecutorDeps, type PendingAction } from './pass.js';
import { programBlastRadius } from '../reversibility/blast.js';

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
export type ResumeMessage = { action?: 'resume' | 'release' | 'revoke' | 'edit'; by?: string; holdId?: string };

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
    const blasted = new Set<number>();

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
    const end = async (name: string, to: RunStatus, reason: string, extra: { error?: unknown; actorId?: string | null; trigger?: 'run_failure' | 'divergence' | 'verification' } = {}): Promise<RunOutcome> => {
      await ctx.step(`${name}:skip`, () => deps.store.skipPending(tenantId, runId), { retries: 5 });
      // THE SAGA (M6 §5.8): a run that fails with committed actions it can still undo compensates
      // them — strict reverse order of commitment — and ends COMPENSATED or COMPENSATION_FAILED.
      const rev = deps.reversibility;
      if (to === 'FAILED' && rev) {
        const plan = await ctx.step(`${name}:saga:plan`, async () => {
          const rb = await rev.plan(tenantId, { runId, scope: 'run', trigger: extra.trigger ?? 'run_failure', requestedBy: null, requestedAt: new Date(), });
          return { id: rb.id, n: rb.compensationIds.length };
        }, { retries: 5 });
        if (plan.n > 0) {
          const t = await transition(`${name}:compensating`, 'COMPENSATING', { reason: `${reason} — undoing ${plan.n} action${plan.n === 1 ? '' : 's'} it had done`, ...(extra.error !== undefined ? { error: extra.error } : {}) });
          if (!t.ok) return { status: t.from };
          const agent = await ctx.step(`${name}:saga:agent`, async () => (await deps.store.load(tenantId, runId))?.agentId ?? null, { retries: 5 });
          const out = await rev.rollback(ctx, tenantId, plan.id, { agentId: agent ?? undefined });
          const done = out.state === 'failed' ? 'COMPENSATION_FAILED' : 'COMPENSATED';
          const summary = out.state === 'failed'
            ? `${reason}. Undo failed on ${out.failed!.toolId} (${out.failed!.error.code}); ${out.reversed.length} undone, ${out.notAttempted.length} not attempted — see the incident`
            : `${reason}. Undid ${out.reversed.length} action${out.reversed.length === 1 ? '' : 's'}${out.permanent.length ? `; ${out.permanent.length} could no longer be undone` : ''}`;
          const t2 = await transition(`${name}:${done.toLowerCase()}`, done, { reason: summary, error: { cause: extra.error ?? reason, rollback: out } });
          return t2.ok ? { status: done, reason: summary } : { status: t2.from };
        }
      }
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
          return p ? { ast: p.ast, modelId: p.modelId, createdAt: p.createdAt.toISOString(), digest: p.digest } : null;
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

      // M6 §5.6: before a program version first runs, its blast radius — every call simulated
      // (reads executed), aggregated, stored. A preview: it never blocks or fails the run.
      const rev = deps.reversibility;
      if (rev && !blasted.has(version)) {
        blasted.add(version);
        await ctx.step(`blast:v${version}`, async () => {
          try {
            const out = await programBlastRadius(deps, { tenantId, runId, bindings: run.checkpoint.bindings, program, modelId: prog.modelId, now: prog.createdAt, inputs: runInputs(run), maxCollection: run.spec.limits.maxFanout });
            await rev.deps.store.saveBlastRadius(tenantId, { runId, programVersion: version, programDigest: prog.digest ?? '', effects: out.effects, summary: out.summary });
            return out.summary.consequential;
          } catch (e) {
            deps.log.warn({ err: e, run_id: runId }, 'blast radius could not be computed; the run continues without a preview');
            return -1;
          }
        });
      }

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
        const rev = deps.reversibility;
        if (pending.kind === 'hold' && pending.key && rev && pending.nodeRowId) {
          // M6 §5.5: the hold is a ROW. A person's revoke / release / edit is committed on it by a
          // compare-and-set (the control plane), and so is the timer's release (here): whichever
          // commits first is what happened, across restarts. The message only wakes us early.
          const key = pending.key;
          const windowless = !pending.holdWindowMs;
          const hold = await ctx.step(`hold:${passNo}:open`, () =>
            rev.openHold({
              tenantId,
              runId,
              principalUserId: run.principalUserId,
              agentId: run.agentId,
              nodeRowId: pending.nodeRowId!,
              actionId: pending.actionId ?? null,
              holdKey: key,
              toolId: pending.toolId ?? 'action',
              windowMs: pending.holdWindowMs ?? null,
              heldAt: pending.heldAt ? Date.parse(pending.heldAt) : Date.now(),
              artifact: { toolId: pending.toolId ?? '', args: pending.args ?? {}, effect: pending.effect ? { ...pending.effect } : null, reason: pending.reason },
            }).then((h) => ({ id: h.id, expiresAt: h.expiresAt.toISOString() })),
            { retries: 5 },
          );
          await ctx.step(`hold:${passNo}:pending`, () => deps.store.setStatus(tenantId, runId, 'HELD', { pending: { ...pending, holdId: hold.id, releaseAt: pending.holdWindowMs ? hold.expiresAt : undefined } }).catch(() => undefined), { retries: 3 });
          let settled: { state: string; by: string | null } | null = null;
          for (let i = 0; i < 50 && !settled; i++) {
            const remaining = Math.max(0, Date.parse(hold.expiresAt) - (await ctx.now())) / 1000;
            const m = await ctx.recv<ResumeMessage>(TOPICS.resume, Math.max(0.05, remaining));
            const s = await ctx.step(`hold:${passNo}:settle:${i}`, () => rev.settleHold(tenantId, hold.id, !m, windowless), { retries: 5 });
            if (s.state !== 'holding') settled = s;
          }
          const st = settled?.state ?? 'missing';
          if (st === 'revoked') {
            await ctx.step(`revoke:${passNo}`, () => deps.store.markNode(tenantId, runId, pending.nodeRowId!, { status: 'skipped', error: { code: 'REVOKED', by: settled?.by ?? null }, end: true }), { retries: 5 });
            return end(`revoked:${passNo}`, 'CANCELLED', `revoked during its hold window (${pending.toolId ?? 'action'} never ran)`, { actorId: settled?.by ?? null });
          }
          if (st === 'edited_requeued') {
            await ctx.step(`edited:${passNo}`, () => deps.store.updateCheckpoint(tenantId, runId, (cp) => ({ ...cp, edits: { ...(cp.edits ?? {}), [key.split('~')[0]!]: hold.id } })), { retries: 5 });
            deps.log.info({ run_id: runId, key }, 'held action edited; deciding it again');
            continue;
          }
          if (st === 'released' || st === 'expired_released') {
            released.add(key);
            await ctx.step(`released:${passNo}`, () => deps.store.updateCheckpoint(tenantId, runId, (cp) => ({ ...cp, released: [...new Set([...(cp.released ?? []), key])] })), { retries: 5 });
            deps.log.info({ run_id: runId, key, early: st === 'released' }, st === 'released' ? 'hold released early' : 'hold window passed; releasing');
            continue;
          }
          if (st === 'expired') return end(`heldexpired:${passNo}`, 'FAILED', 'held for 7 days without release');
          // A hold whose state cannot be established is never released on a guess.
          const why = `the hold on ${pending.toolId ?? 'an action'} could not be settled (${st}); it was not released`;
          await ctx.step(`hold:${passNo}:attention`, () => rev.deps.store.openIncident(tenantId, { kind: 'hold_ambiguous', severity: 'HIGH', title: why, runId, actionId: pending.actionId ?? null, detail: { holdId: hold.id, state: st } }), { retries: 5 });
          const a = await transition(`attention:${passNo}`, 'NEEDS_ATTENTION', { reason: why, pending: { kind: 'attention', reason: why } });
          return a.ok ? { status: 'NEEDS_ATTENTION', reason: why } : { status: a.from };
        }
        if (pending.kind === 'hold' && pending.key && pending.holdWindowMs) {
          // Without the reversibility engine (tests of the executor alone): the M5 behaviour.
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
        if (stop.reason === 'divergence') return end(`diverged:${passNo}`, 'FAILED', stop.message, { error: { reason: 'divergence' }, trigger: 'divergence' });
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
