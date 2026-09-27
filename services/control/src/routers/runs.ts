import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { canApproveAs, fga, hasCapability } from '@vega/authz';
import { schema } from '@vega/db';
import { CreateRun, RunDecision, RunInput, RunListQuery, TERMINAL_RUN_STATUSES, Uuid, type Ambiguity, type RunView } from '@vega/contracts';
import { print, type Program } from '@vega/dsl';
import { TransitionError } from '@vega/runs';
import { problems } from '@vega/shared';
import { applyClarification } from '../agent/intent.js';
import { bindConnectors, createRun, RunRefused, type AgentCoreDeps, type RunCoordinator } from '../agent/coordinator.js';
import { ExecutionRefused, ExecutionUnavailable } from '../connectors/deps.js';
import { ProblemError, procedure, requireCapability, requireRelation, router, type AuthedContext } from '../trpc.js';

/**
 * Runs — docs/module4.md §7. A run is created from an objective (C1 runs inline, so the answer
 * already carries the resolved entities), planned and executed in the background, and driven
 * from here: cancel, answer a clarification, decide an approval, resume after re-authorizing.
 * Nothing here executes a tool: the executor does, behind the gate.
 */

export function agentCore(ctx: AuthedContext): { core: AgentCoreDeps; coordinator: RunCoordinator } {
  if (!ctx.deps.agent) throw new ProblemError(problems.upstreamUnavailable('agent core'));
  return ctx.deps.agent;
}

export function refusal(e: unknown): never {
  if (e instanceof RunRefused) {
    throw new ProblemError(e.code === 'NOT_FOUND' ? problems.notFound(e.message) : e.code === 'FORBIDDEN' ? problems.forbidden(e.message) : problems.preconditionFailed(e.message));
  }
  if (e instanceof TransitionError) throw new ProblemError(problems.conflict(e.message));
  if (e instanceof ExecutionUnavailable) throw new ProblemError(problems.upstreamUnavailable('execution'));
  if (e instanceof ExecutionRefused) throw new ProblemError(e.code === 'CONFLICT' ? problems.conflict(e.message) : problems.preconditionFailed(e.message));
  throw e;
}

/** Read access: the run's workspace membership (or tenant-wide audit/administration). */
export async function readable(ctx: AuthedContext, id: string): Promise<RunView> {
  requireCapability(ctx, 'agents.read');
  const { core } = agentCore(ctx);
  const run = await core.store.view(ctx.principal.tenantId, id);
  if (!run) throw new ProblemError(problems.notFound('run not found'));
  if (run.principalUserId !== ctx.principal.userId && !hasCapability(ctx.principal.role, 'workspaces.manage') && !hasCapability(ctx.principal.role, 'audit.read')) {
    await requireRelation(ctx, 'member', fga.workspace(run.workspaceId));
  }
  return run;
}

/** Acting on a run: whoever it runs for, or whoever may manage its agent. */
async function actable(ctx: AuthedContext, id: string): Promise<RunView> {
  const run = await readable(ctx, id);
  if (run.principalUserId !== ctx.principal.userId) await requireRelation(ctx, 'can_manage', fga.agent(run.agentId));
  return run;
}

/** Release or revoke a held action: its principal, or anyone who decides approvals. */
async function holdAction(ctx: AuthedContext, id: string, action: 'release' | 'revoke'): Promise<RunView> {
  const run = await readable(ctx, id);
  if (run.principalUserId !== ctx.principal.userId) requireCapability(ctx, 'approvals.decide');
  const pending = run.pending as { kind?: string; key?: string; toolId?: string } | null;
  if (run.status !== 'HELD' || pending?.kind !== 'hold') throw new ProblemError(problems.preconditionFailed('this run has no action in a hold window'));
  const { core } = agentCore(ctx);
  await ctx.db((db) =>
    db.insert(schema.platformEvents).values({ tenantId: run.tenantId, actorId: ctx.principal.userId, kind: action === 'release' ? 'run.hold_released' : 'run.hold_revoked', payload: { runId: run.id, key: pending.key ?? null, toolId: pending.toolId ?? null } }),
  );
  try {
    await core.execution.signalRun({ tenantId: run.tenantId, runId: run.id, topic: 'resume', message: { action, by: ctx.principal.userId } });
  } catch (e) {
    return refusal(e);
  }
  return run;
}

const printed = (ast: unknown) => {
  try {
    return print(ast as Program);
  } catch {
    return null;
  }
};

export const runsRouter = router({
  create: procedure.input(CreateRun).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.run');
    await requireRelation(ctx, 'can_run', fga.agent(input.agentId));
    const { core, coordinator } = agentCore(ctx);
    if (input.conversationId) {
      const [c] = await ctx.db((db) => db.select().from(schema.conversations).where(eq(schema.conversations.id, input.conversationId!)));
      if (!c || c.userId !== ctx.principal.userId || c.agentId !== input.agentId) throw new ProblemError(problems.notFound('conversation not found'));
    }
    try {
      const run = await createRun(core, {
        tenantId: ctx.principal.tenantId,
        agentId: input.agentId,
        principalUserId: ctx.principal.userId,
        trigger: input.conversationId ? 'chat' : 'api',
        objective: input.objective,
        conversationId: input.conversationId,
      });
      coordinator.kick(run.tenantId, run.id);
      return run;
    } catch (e) {
      return refusal(e);
    }
  }),

  list: procedure.input(RunListQuery).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const { core } = agentCore(ctx);
    const wide = hasCapability(ctx.principal.role, 'workspaces.manage') || hasCapability(ctx.principal.role, 'audit.read');
    if (input.workspaceId && !wide) await requireRelation(ctx, 'member', fga.workspace(input.workspaceId));
    const items = await core.store.list(ctx.principal.tenantId, {
      status: input.status,
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      // Without tenant-wide rights, a list shows your own runs (or a workspace you belong to).
      principalUserId: wide || input.workspaceId ? undefined : ctx.principal.userId,
      limit: input.limit,
    });
    return { items };
  }),

  get: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    const run = await readable(ctx, input.id);
    const { core } = agentCore(ctx);
    const t = ctx.principal.tenantId;
    const [nodes, actions, programs, replans] = await Promise.all([core.store.nodes(t, run.id), core.store.actions(t, run.id), core.store.programs(t, run.id), core.store.replans(t, run.id)]);
    return {
      run,
      nodes,
      actions,
      programs: programs.map((p) => ({ version: p.version, digest: p.digest, modelId: p.modelId, source: p.source, attempts: p.attempts, createdAt: p.createdAt.toISOString(), text: printed(p.ast), ast: p.ast })),
      replans,
    };
  }),

  program: procedure.input(z.object({ id: Uuid, version: z.number().int().min(1).optional() })).query(async ({ ctx, input }) => {
    const run = await readable(ctx, input.id);
    const { core } = agentCore(ctx);
    const p = await core.store.program(ctx.principal.tenantId, run.id, input.version ?? run.programVersion);
    if (!p) throw new ProblemError(problems.notFound('no such program version'));
    return { version: p.version, digest: p.digest, modelId: p.modelId, source: p.source, attempts: p.attempts, ast: p.ast, text: printed(p.ast), createdAt: p.createdAt.toISOString() };
  }),

  replans: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    const run = await readable(ctx, input.id);
    return { items: await agentCore(ctx).core.store.replans(ctx.principal.tenantId, run.id) };
  }),

  /** Progress after an event id: the gateway's SSE stream polls this. */
  events: procedure.input(z.object({ id: Uuid, after: z.string().regex(/^\d{1,19}$/).default('0') })).query(async ({ ctx, input }) => {
    const run = await readable(ctx, input.id);
    const events = await agentCore(ctx).core.store.events(ctx.principal.tenantId, run.id, BigInt(input.after));
    return { run, events };
  }),

  cancel: procedure.input(z.object({ id: Uuid, reason: z.string().max(500).optional() })).mutation(async ({ ctx, input }) => {
    const run = await actable(ctx, input.id);
    if (TERMINAL_RUN_STATUSES.has(run.status)) return run;
    const { core } = agentCore(ctx);
    const loaded = await core.store.load(ctx.principal.tenantId, run.id);
    try {
      if (loaded?.checkpoint.started) await core.execution.cancelRun({ tenantId: run.tenantId, runId: run.id, by: ctx.principal.userId, reason: input.reason ?? 'cancelled by user' });
      else {
        await core.store.setStatus(run.tenantId, run.id, 'CANCELLED', { reason: input.reason ?? 'cancelled by user', actorId: ctx.principal.userId });
        await core.store.skipPending(run.tenantId, run.id);
      }
    } catch (e) {
      return refusal(e);
    }
    return (await core.store.view(run.tenantId, run.id))!;
  }),

  /** Answers a blocking clarification (§8.2): C1 updates the objective, C2 replans. */
  input: procedure.input(RunInput.extend({ id: Uuid })).mutation(async ({ ctx, input }) => {
    const run = await actable(ctx, input.id);
    const pending = run.pending as { kind?: string; source?: string; ambiguity?: Ambiguity } | null;
    if (run.status !== 'AWAITING_INPUT' || pending?.kind !== 'clarification') throw new ProblemError(problems.preconditionFailed('this run is not waiting for a clarification'));
    const { core, coordinator } = agentCore(ctx);
    let objective;
    try {
      objective = applyClarification(run.objective, input.field, input.choice);
    } catch (e) {
      throw new ProblemError(problems.validation([{ path: 'choice', message: e instanceof Error ? e.message : 'invalid choice' }]));
    }
    await core.store.updateObjective(run.tenantId, run.id, objective);
    await core.store.updateCheckpoint(run.tenantId, run.id, (cp) => ({ ...cp, answers: [...(cp.answers ?? []), { field: input.field, choice: input.choice, by: ctx.principal.userId, at: new Date().toISOString() }] }));
    await ctx.db((db) => db.insert(schema.platformEvents).values({ tenantId: run.tenantId, actorId: ctx.principal.userId, kind: 'run.clarified', payload: { runId: run.id, field: input.field, choice: input.choice } }));
    try {
      if (pending.source === 'plan') {
        // Blocked before (re)execution: plan again with the answer.
        await core.store.setStatus(run.tenantId, run.id, 'PLANNING', { from: ['AWAITING_INPUT'], actorId: ctx.principal.userId });
        coordinator.kick(run.tenantId, run.id);
      } else {
        // The executor is waiting on it: it asks for the replan itself.
        await core.execution.signalRun({ tenantId: run.tenantId, runId: run.id, topic: 'input', message: { field: input.field, choice: input.choice, by: ctx.principal.userId } });
      }
    } catch (e) {
      return refusal(e);
    }
    return (await core.store.view(run.tenantId, run.id))!;
  }),

  /**
   * Decides the pending approval. The decision names exactly what the run showed (its key).
   *
   * Module 5: a policy names WHO approves (`approver_role`); a dual approval needs two different
   * people; under separation of duties the person the run acts for approves nothing. Refused
   * here with a reason — and checked again by the executor, which is what lets the action run.
   * Rejecting is always open to the run's own principal: stopping your own action needs no role.
   */
  decide: procedure.input(RunDecision.extend({ id: Uuid })).mutation(async ({ ctx, input }) => {
    const run = await readable(ctx, input.id);
    const pending = run.pending as {
      kind?: string;
      key?: string;
      approvalsRequired?: number;
      approvedBy?: string[];
      policy?: { approverRole?: string | null; separationOfDuties?: boolean };
    } | null;
    if (run.status !== 'AWAITING_APPROVAL' || pending?.kind !== 'approval' || !pending.key) throw new ProblemError(problems.preconditionFailed('this run is not waiting for an approval'));
    const own = run.principalUserId === ctx.principal.userId;
    const role = pending.policy?.approverRole ?? null;
    if (input.decision === 'reject') {
      if (!own) requireCapability(ctx, 'approvals.decide');
    } else {
      if (role) {
        if (!canApproveAs(ctx.principal.role, role)) throw new ProblemError(problems.forbidden(`this action needs approval by ${role}; your role is ${ctx.principal.role}`));
      } else if (!own) requireCapability(ctx, 'approvals.decide');
      if (pending.policy?.separationOfDuties && own) throw new ProblemError(problems.forbidden('separation of duties: the person this run acts for cannot approve its action'));
      if ((pending.approvedBy ?? []).includes(ctx.principal.userId)) throw new ProblemError(problems.conflict(`you have already approved this action; ${pending.approvalsRequired ?? 1} different approvers are required`));
    }
    const { core } = agentCore(ctx);
    await ctx.db((db) =>
      db.insert(schema.platformEvents).values({ tenantId: run.tenantId, actorId: ctx.principal.userId, kind: 'run.decision', payload: { runId: run.id, key: pending.key, decision: input.decision, note: input.note ?? null } }),
    );
    try {
      await core.execution.signalRun({ tenantId: run.tenantId, runId: run.id, topic: 'decision', message: { key: pending.key, decision: input.decision, by: ctx.principal.userId, ...(input.note ? { note: input.note } : {}) } });
    } catch (e) {
      return refusal(e);
    }
    return run;
  }),

  /** A policy hold (ALLOW_WITH_HOLD): run it now instead of when the window ends. */
  release: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => holdAction(ctx, input.id, 'release')),

  /** A policy hold: cancel it inside its window. The action never happens. */
  revoke: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => holdAction(ctx, input.id, 'revoke')),

  /** Resumes a run waiting on a connector or a credential (after re-authorizing, say). */
  resume: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    const run = await actable(ctx, input.id);
    const pending = run.pending as { kind?: string } | null;
    const resumable = (run.status === 'AWAITING_INPUT' && pending?.kind === 'reauthorize') || run.status === 'HELD';
    if (!resumable) throw new ProblemError(problems.preconditionFailed('this run is not waiting on a connector or a credential'));
    const { core, coordinator } = agentCore(ctx);
    const loaded = (await core.store.load(run.tenantId, run.id))!;
    const bindings = await bindConnectors(run.tenantId, run.principalUserId, loaded.spec, core.registry);
    await core.store.updateCheckpoint(run.tenantId, run.id, (cp) => ({ ...cp, bindings: { ...cp.bindings, ...bindings } }));
    try {
      await core.execution.signalRun({ tenantId: run.tenantId, runId: run.id, topic: 'resume', message: { action: 'resume', by: ctx.principal.userId }, token: await coordinator.mint(loaded) });
    } catch (e) {
      return refusal(e);
    }
    return run;
  }),
});
