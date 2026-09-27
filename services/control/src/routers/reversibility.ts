import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { fga, hasCapability } from '@vega/authz';
import { schema, withTenant } from '@vega/db';
import { Uuid } from '@vega/contracts';
import {
  applyEdit,
  editableFields,
  fastRevokeKeys,
  parseRevokeToken,
  pushTopic,
  remainingText,
  undoable,
  undoStats,
  type CompensationRow,
  type FastRevokeEntry,
  type HoldRow,
  type ReversibilityStore,
} from '@vega/compensators';
import { problems } from '@vega/shared';
import { holdRevokeProcedure, procedure, ProblemError, requireCapability, requireRelation, router, type AuthedContext, type Context } from '../trpc.js';
import { agentCore, readable, refusal } from './runs.js';

/**
 * Module 6 — the Reversibility Layer's API (docs/module6.md §7). Nothing here calls a provider:
 * a revoke / release / edit is COMMITTED on the hold row (the compare-and-set the executor's
 * timer races against) and then signalled; an undo is authorized, its consequence confirmed,
 * and handed to the execution plane as a rollback.
 *
 * The asymmetry is deliberate (§5.5): revoking is the cheapest thing to do — precomputed
 * authorization from Valkey, no relationship check, and from a push with no session at all —
 * while releasing early or editing needs a signed-in person who may act on the run.
 */

function rev(ctx: Context): NonNullable<Context['deps']['reversibility']> {
  if (!ctx.deps.reversibility) throw new ProblemError(problems.upstreamUnavailable('reversibility'));
  return ctx.deps.reversibility;
}

const wide = (ctx: AuthedContext) => hasCapability(ctx.principal.role, 'audit.read') || hasCapability(ctx.principal.role, 'workspaces.manage');

async function signal(ctx: AuthedContext | Context, tenantId: string, runId: string, message: Record<string, unknown>) {
  try {
    await ctx.deps.agent?.core.execution.signalRun({ tenantId, runId, topic: 'resume', message });
  } catch (e) {
    // The decision is already committed on the hold row; the executor honours it when its
    // window ends even if this wake-up never arrives (§5.5 restart safety).
    ctx.deps.logger.warn({ err: e, run_id: runId }, 'could not wake the run after a hold decision; it will settle at the window');
  }
}

/** The fast path: precomputed revokers from Valkey, the database only when the cache has nothing. */
async function allowedToRevoke(ctx: Context, tenantId: string, holdId: string): Promise<{ allowed: string[]; runId: string } | null> {
  const r = rev(ctx);
  const cached = await r.cache?.get(fastRevokeKeys.hold(holdId)).catch(() => null);
  if (cached) {
    const e = JSON.parse(cached) as FastRevokeEntry;
    if (e.tenantId === tenantId) return { allowed: e.allowed, runId: e.runId };
  }
  const h = await r.store.hold(tenantId, holdId);
  return h ? { allowed: h.allowedRevokers, runId: h.runId } : null;
}

function holdView(h: HoldRow, now: number) {
  return {
    id: h.id,
    runId: h.runId,
    actionId: h.actionId,
    toolId: h.toolId,
    state: h.state,
    windowMs: h.windowMs,
    expiresAt: h.expiresAt.toISOString(),
    remainingMs: h.state === 'holding' ? Math.max(0, h.expiresAt.getTime() - now) : 0,
    edited: h.edited,
    revokedBy: h.revokedBy,
    revokeChannel: h.revokeChannel,
    releasedBy: h.releasedBy,
    createdAt: h.createdAt.toISOString(),
  };
}

const TOO_LATE: Record<string, string> = {
  released: 'it was already released early',
  expired_released: 'its hold window had already ended and it was released',
  revoked: 'it was already revoked',
  edited_requeued: 'it was edited and requeued; act on the new version',
  expired: 'it expired without release',
  needs_attention: 'it needs attention: its state could not be settled',
};

/** Commits a revoke on the hold row, records Time-to-Undo, wakes the run. */
async function commitRevoke(ctx: Context, tenantId: string, holdId: string, by: string, channel: 'app' | 'push', requestedAt: Date) {
  const r = rev(ctx);
  const out = await r.store.decideHold(tenantId, holdId, 'revoked', { by, channel, requestedAt });
  if (!out.hold) throw new ProblemError(problems.notFound('hold not found'));
  if (!out.won) return { revoked: out.hold.state === 'revoked', state: out.hold.state, message: `Too late to revoke: ${TOO_LATE[out.hold.state] ?? out.hold.state}.` };
  // Restored = the moment nothing can reach the provider any more: this commit.
  await r.store.recordUndo(tenantId, { runId: out.hold.runId, actionId: out.hold.actionId, toolId: out.hold.toolId, kind: 'revoke', channel, requestedAt, restoredAt: new Date(), succeeded: true });
  await signal(ctx, tenantId, out.hold.runId, { action: 'revoke', by, holdId });
  return { revoked: true, state: 'revoked' as const, message: 'Revoked. It never reached the provider.' };
}

/** Acting on a run beyond revoking: whoever it runs for, or who may decide approvals. */
async function mayRelease(ctx: AuthedContext, runId: string) {
  const run = await readable(ctx, runId);
  if (run.principalUserId !== ctx.principal.userId) requireCapability(ctx, 'approvals.decide');
  return run;
}

function compensationView(c: CompensationRow, now: number) {
  const u = undoable(c, now);
  return {
    id: c.id,
    actionId: c.actionId,
    runId: c.runId,
    toolId: c.toolId,
    ref: c.compensatorRef,
    confidence: c.confidence,
    sideEffects: c.sideEffects,
    description: c.description,
    state: c.state,
    forwardState: c.forwardState,
    commitSeq: c.commitSeq,
    committedAt: c.committedAt?.toISOString() ?? null,
    ttlAt: c.ttlAt?.toISOString() ?? null,
    availableFor: remainingText(c.ttlAt, now),
    undoable: u.ok,
    reason: u.ok ? null : u.reason,
    attempts: c.attempts,
    rollbackId: c.rollbackId,
    executedAt: c.executedAt?.toISOString() ?? null,
    result: c.result,
    lastError: c.lastError,
  };
}

async function startRollback(ctx: AuthedContext, input: { runId: string; scope: 'action' | 'run'; compensationId?: string; agentId: string }) {
  const { core } = agentCore(ctx);
  if (!core.execution.startRollback) throw new ProblemError(problems.upstreamUnavailable('execution'));
  try {
    return await core.execution.startRollback({ tenantId: ctx.principal.tenantId, runId: input.runId, scope: input.scope, compensationId: input.compensationId, requestedBy: ctx.principal.userId, requestedAt: new Date().toISOString(), agentId: input.agentId });
  } catch (e) {
    return refusal(e);
  }
}

// ------------------------------------------------------------------ holds

export const holdsRouter = router({
  /** Held actions the caller may revoke (all of them for audit/admin roles). */
  list: procedure.input(z.object({ runId: Uuid.optional(), active: z.boolean().default(true) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const rows = await rev(ctx).store.holds(ctx.principal.tenantId, { runId: input.runId, states: input.active ? ['holding'] : undefined });
    const now = Date.now();
    return { items: rows.filter((h) => wide(ctx) || h.allowedRevokers.includes(ctx.principal.userId)).map((h) => holdView(h, now)) };
  }),

  /** One hold with its held content — only for someone who may revoke it (§10). */
  get: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const r = rev(ctx);
    const h = await r.store.hold(ctx.principal.tenantId, input.id);
    if (!h) throw new ProblemError(problems.notFound('hold not found'));
    if (!h.allowedRevokers.includes(ctx.principal.userId) && !wide(ctx)) throw new ProblemError(problems.forbidden('only those who may revoke it can see what is held'));
    const { artifact, editedArgs } = await r.store.openArtifact(ctx.principal.tenantId, h.id);
    const decls = await agentCore(ctx).core.execution.toolDeclarations(ctx.principal.tenantId, [h.toolId]).catch(() => []);
    const args = editedArgs ?? artifact.args;
    return { hold: holdView(h, Date.now()), artifact: { ...artifact, args }, editable: decls[0] ? editableFields(decls[0], args) : [] };
  }),

  /** One tap, no confirmation, precomputed authorization: the fastest thing in the product. */
  revoke: procedure.input(z.object({ id: Uuid, reason: z.string().max(500).optional() })).mutation(async ({ ctx, input }) => {
    const requestedAt = new Date();
    const who = await allowedToRevoke(ctx, ctx.principal.tenantId, input.id);
    if (!who) throw new ProblemError(problems.notFound('hold not found'));
    if (!who.allowed.includes(ctx.principal.userId)) throw new ProblemError(problems.forbidden('you are not one of the people who may revoke this action'));
    return commitRevoke(ctx, ctx.principal.tenantId, input.id, ctx.principal.userId, 'app', requestedAt);
  }),

  /** Release early: a signed-in person who may act on the run (never a push capability). */
  release: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    const r = rev(ctx);
    const h = await r.store.hold(ctx.principal.tenantId, input.id);
    if (!h) throw new ProblemError(problems.notFound('hold not found'));
    await mayRelease(ctx, h.runId);
    const out = await r.store.decideHold(ctx.principal.tenantId, h.id, 'released', { by: ctx.principal.userId, requestedAt: new Date() });
    if (!out.won) throw new ProblemError(problems.conflict(`It cannot be released: ${TOO_LATE[out.hold?.state ?? ''] ?? 'it is no longer held'}.`));
    await signal(ctx, ctx.principal.tenantId, h.runId, { action: 'release', by: ctx.principal.userId, holdId: h.id });
    return { released: true };
  }),

  /** Edit and requeue: new content, decided and held again; the diff is override telemetry (M10). */
  edit: procedure.input(z.object({ id: Uuid, patch: z.record(z.string(), z.unknown()) })).mutation(async ({ ctx, input }) => {
    const r = rev(ctx);
    const h = await r.store.hold(ctx.principal.tenantId, input.id);
    if (!h) throw new ProblemError(problems.notFound('hold not found'));
    await mayRelease(ctx, h.runId);
    if (h.state !== 'holding') throw new ProblemError(problems.conflict(`It cannot be edited: ${TOO_LATE[h.state] ?? 'it is no longer held'}.`));
    const [decl] = await agentCore(ctx).core.execution.toolDeclarations(ctx.principal.tenantId, [h.toolId]);
    if (!decl) throw new ProblemError(problems.preconditionFailed(`${h.toolId} is no longer available`));
    const { artifact, editedArgs } = await r.store.openArtifact(ctx.principal.tenantId, h.id);
    const edit = applyEdit(decl, editedArgs ?? artifact.args, input.patch, { userId: ctx.principal.userId, at: new Date() });
    if (!edit.ok) throw new ProblemError(problems.validation(edit.problems.map((p) => ({ path: p.split(':')[0]!, message: p }))));
    const out = await r.store.decideHold(ctx.principal.tenantId, h.id, 'edited_requeued', { by: ctx.principal.userId, editedArgs: edit.args, editDiff: edit.diff, requestedAt: new Date() });
    if (!out.won) throw new ProblemError(problems.conflict(`It cannot be edited: ${TOO_LATE[out.hold?.state ?? ''] ?? 'it is no longer held'}.`));
    await signal(ctx, ctx.principal.tenantId, h.runId, { action: 'edit', by: ctx.principal.userId, holdId: h.id });
    return { edited: true, fields: Object.keys(edit.diff.fields) };
  }),

  /** The one-tap revoke from a push: no session, a capability for exactly one hold. */
  revokeWithToken: holdRevokeProcedure.input(z.object({ token: z.string().min(10).max(200) })).mutation(async ({ ctx, input }) => {
    const requestedAt = new Date();
    const cap = parseRevokeToken(input.token);
    if (!cap) throw new ProblemError(problems.notFound('this revoke link is not valid'));
    const r = rev(ctx);
    const cachedId = await r.cache?.get(fastRevokeKeys.token(cap.hash)).catch(() => null);
    const cached = cachedId ? await r.store.hold(cap.tenantId, cachedId) : null;
    // The cache names a hold; the database confirms the capability is ITS capability.
    const h = cached && (await r.store.holdByTokenHash(cap.tenantId, cap.hash))?.id === cached.id ? cached : await r.store.holdByTokenHash(cap.tenantId, cap.hash);
    if (!h) throw new ProblemError(problems.notFound('this revoke link is not valid'));
    // The capability is the authorization; it is attributed to the person it was sent to.
    const [run] = await withTenant(cap.tenantId, (db) => db.select({ principal: schema.runs.principalUserId }).from(schema.runs).where(eq(schema.runs.id, h.runId)));
    return commitRevoke(ctx, cap.tenantId, h.id, run?.principal ?? h.allowedRevokers[0]!, 'push', requestedAt);
  }),
});

// ------------------------------------------------------------------ undo (compensation)

export const undoRouter = router({
  /** What undoing this action would do, whether it still can, and for how long (§6.3). */
  compensation: procedure.input(z.object({ actionId: Uuid })).query(async ({ ctx, input }) => {
    const r = rev(ctx);
    const [action] = await ctx.db((db) => db.select().from(schema.actions).where(eq(schema.actions.id, input.actionId)));
    if (!action) throw new ProblemError(problems.notFound('action not found'));
    await readable(ctx, action.runId);
    const c = await r.store.byAction(ctx.principal.tenantId, action.id);
    if (!c) {
      const holdOnly = action.reversibility === 'R2';
      return { compensation: null, explanation: holdOnly ? 'This cannot be undone once it has been released: it could only be stopped while it was held.' : action.reversibility === 'R3' ? 'This action is irreversible.' : 'This action changed nothing that needs undoing.' };
    }
    return { compensation: compensationView(c, Date.now()), explanation: null };
  }),

  /** Undo one committed action. Third-party-visible undos need `confirm: true` (§5.3). */
  compensate: procedure.input(z.object({ actionId: Uuid, confirm: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
    const r = rev(ctx);
    const [action] = await ctx.db((db) => db.select().from(schema.actions).where(eq(schema.actions.id, input.actionId)));
    if (!action) throw new ProblemError(problems.notFound('action not found'));
    const run = await readable(ctx, action.runId);
    if (run.principalUserId !== ctx.principal.userId) await requireRelation(ctx, 'can_manage', fga.agent(run.agentId));
    const c = await r.store.byAction(ctx.principal.tenantId, action.id);
    if (!c) throw new ProblemError(problems.preconditionFailed('this action has no undo'));
    const u = undoable(c, Date.now());
    if (!u.ok && c.state !== 'failed') throw new ProblemError(problems.preconditionFailed(`It cannot be undone: ${u.reason}.`));
    if (c.sideEffects === 'NOTIFIES_THIRD_PARTY' && !input.confirm) throw new ProblemError(problems.confirmationRequired(c.description));
    return startRollback(ctx, { runId: run.id, scope: 'action', compensationId: c.id, agentId: run.agentId });
  }),

  /** A run's compensations (most recent first) and its rollbacks: the compensation status (§6.4). */
  forRun: procedure.input(z.object({ runId: Uuid })).query(async ({ ctx, input }) => {
    const run = await readable(ctx, input.runId);
    const r = rev(ctx);
    const now = Date.now();
    const [comps, rollbacks, incidents] = await Promise.all([r.store.forRun(ctx.principal.tenantId, run.id), r.store.rollbacksFor(ctx.principal.tenantId, run.id), r.store.incidents(ctx.principal.tenantId, { runId: run.id })]);
    return {
      compensations: comps.map((c) => compensationView(c, now)),
      rollbacks: rollbacks.map((b) => ({ ...b, requestedAt: b.requestedAt.toISOString(), finishedAt: b.finishedAt?.toISOString() ?? null })),
      incidents: incidents.map((i) => ({ id: i.id, kind: i.kind, severity: i.severity, title: i.title, state: i.state, detail: i.detail, createdAt: i.createdAt.toISOString() })),
    };
  }),

  /** Undo everything a run did that can still be undone, last first. */
  rollbackRun: procedure.input(z.object({ runId: Uuid, confirm: z.boolean().default(false) })).mutation(async ({ ctx, input }) => {
    const run = await readable(ctx, input.runId);
    if (run.principalUserId !== ctx.principal.userId) await requireRelation(ctx, 'can_manage', fga.agent(run.agentId));
    const now = Date.now();
    const open = (await rev(ctx).store.forRun(ctx.principal.tenantId, run.id)).filter((c) => undoable(c, now).ok);
    if (!open.length) throw new ProblemError(problems.preconditionFailed('there is nothing left to undo in this run'));
    const visible = open.filter((c) => c.sideEffects === 'NOTIFIES_THIRD_PARTY');
    if (visible.length && !input.confirm) throw new ProblemError(problems.confirmationRequired(visible.map((c) => c.description).join(' ')));
    return startRollback(ctx, { runId: run.id, scope: 'run', agentId: run.agentId });
  }),

  rollback: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    const rb = await rev(ctx).store.rollback(ctx.principal.tenantId, input.id);
    if (!rb) throw new ProblemError(problems.notFound('rollback not found'));
    await readable(ctx, rb.runId);
    return { ...rb, requestedAt: rb.requestedAt.toISOString(), finishedAt: rb.finishedAt?.toISOString() ?? null };
  }),

  blastRadius: procedure.input(z.object({ runId: Uuid })).query(async ({ ctx, input }) => {
    const run = await readable(ctx, input.runId);
    const br = await rev(ctx).store.latestBlastRadius(ctx.principal.tenantId, run.id);
    return br ? { ...br, computedAt: br.computedAt.toISOString() } : null;
  }),

  refreshBlastRadius: procedure.input(z.object({ runId: Uuid })).mutation(async ({ ctx, input }) => {
    const run = await readable(ctx, input.runId);
    const { core } = agentCore(ctx);
    if (!core.execution.refreshBlastRadius) throw new ProblemError(problems.upstreamUnavailable('execution'));
    try {
      return await core.execution.refreshBlastRadius(ctx.principal.tenantId, run.id);
    } catch (e) {
      return refusal(e);
    }
  }),
});

// ------------------------------------------------------------------ metrics, divergences, incidents

export const reversibilityRouter = router({
  /** Time-to-Undo per action type: median, p99, success rate, trend (§5.9, §6.5). */
  timeToUndo: procedure.input(z.object({ days: z.number().int().min(1).max(365).default(30) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const since = new Date(Date.now() - input.days * 86_400_000);
    return { since: since.toISOString(), items: undoStats(await rev(ctx).store.undoSamples(ctx.principal.tenantId, since)) };
  }),

  /** Simulated vs actual, for tool health (§5.7): recent divergences and the rate per tool. */
  divergences: procedure.input(z.object({ toolId: z.string().max(200).optional(), days: z.number().int().min(1).max(365).default(30) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    const since = new Date(Date.now() - input.days * 86_400_000);
    const r = rev(ctx).store;
    const [rows, rates] = await Promise.all([r.divergences(ctx.principal.tenantId, { toolId: input.toolId, since }), r.divergenceRates(ctx.principal.tenantId, since)]);
    return { items: rows.map((d) => ({ id: d.id, runId: d.runId, toolId: d.toolId, severity: d.severity, diff: d.diffJson, createdAt: d.createdAt.toISOString() })), rates };
  }),

  incidents: procedure.input(z.object({ state: z.enum(['open', 'acknowledged', 'resolved']).optional() })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    const rows = await rev(ctx).store.incidents(ctx.principal.tenantId, { states: input.state ? [input.state] : undefined });
    return { items: rows.map((i) => ({ ...i, createdAt: i.createdAt.toISOString(), acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null, resolvedAt: i.resolvedAt?.toISOString() ?? null })) };
  }),

  acknowledgeIncident: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'audit.read');
    const i = await rev(ctx).store.updateIncident(ctx.principal.tenantId, input.id, 'acknowledged', ctx.principal.userId);
    if (!i) throw new ProblemError(problems.conflict('the incident is not open'));
    return { id: i.id, state: i.state };
  }),

  resolveIncident: procedure.input(z.object({ id: Uuid, resolution: z.string().min(3).max(2000) })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'workspaces.manage');
    const i = await rev(ctx).store.updateIncident(ctx.principal.tenantId, input.id, 'resolved', ctx.principal.userId, input.resolution);
    if (!i) throw new ProblemError(problems.conflict('the incident is already resolved'));
    return { id: i.id, state: i.state };
  }),

  /** The caller's push topic (ntfy): subscribe on a phone to get held actions with a Revoke button. */
  pushTopic: procedure.query(async ({ ctx }) => {
    const secret = rev(ctx).pushSecret;
    return secret ? { topic: pushTopic(ctx.principal.userId, secret) } : { topic: null };
  }),
});

export type { ReversibilityStore };
