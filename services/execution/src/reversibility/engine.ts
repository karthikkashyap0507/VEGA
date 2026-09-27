import { and, eq, inArray } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import type { Effect, ToolResult } from '@vega/contracts';
import type { CaptureOutcome, CompensateOutcome, CompensationToken, ForwardOutcome } from '@vega/connector-sdk';
import {
  divergence,
  divergenceText,
  fastRevokeKeys,
  mintRevokeToken,
  nextDelay,
  pushTopic,
  remediationSteps,
  retryable,
  sagaOrder,
  undoable,
  type CompensationRow,
  type FastRevokeEntry,
  type HoldArtifact,
  type HoldRow,
  type ReversibilityStore,
  type RollbackRow,
} from '@vega/compensators';
import type { DurableContext, SimulationResult, StepContext } from '@vega/orchestration';

/**
 * THE REVERSIBILITY ENGINE — docs/module6.md, the execution plane's half. What the executor
 * calls at each point of an action's life:
 *
 *   before the call   arm()          capture the compensation token (the pre-state)
 *   after the call    bind()         record what happened: the TTL starts, the commit order is fixed
 *                     diverged()     the actual effect against the simulated one (§5.7)
 *   R2 held           openHold()     the hold row, precomputed revokers, the one-tap push
 *                     settleHold()   the timer's compare-and-set against a person's revoke
 *   on failure/undo   rollback()     compensations in strict reverse order, bounded retries,
 *                                    and on failure an INCIDENT: page, audit, demotion request
 *
 * Every provider call and every write happens inside the durable workflow's steps, so a restarted
 * worker replays recorded outcomes instead of repeating them.
 */

export interface CompensationPort {
  capture(i: { tenantId: string; connectorId: string; toolId: string; args: unknown; runId: string; nodeId: string }): Promise<CaptureOutcome>;
  compensate(i: { tenantId: string; connectorId: string; token: CompensationToken; compensationId: string; runId?: string }): Promise<CompensateOutcome>;
  describeCompensation(token: CompensationToken): string | undefined;
}

export interface EngineLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

/** Where incidents are paged (ntfy `incidents`, or the log in development — loudly). */
export interface IncidentPager {
  page(i: { tenantId: string; title: string; severity: string; runId: string | null; incidentId: string }): Promise<void>;
}

/** A held action's push to a person's phone, with the one-tap revoke (§6.2). */
export interface HoldNotifier {
  notify(n: { topic: string; title: string; message: string; revokeUrl: string; revokeToken: string; expiresAt: Date }): Promise<void>;
}

export interface FastRevokeCache {
  set(key: string, value: string, ttlMs: number): Promise<void>;
}

export interface AuditSink {
  append(e: { tenantId: string; kind: string; payload: Record<string, unknown> }): Promise<void>;
}

export interface EngineDeps {
  store: ReversibilityStore;
  port: CompensationPort;
  log: EngineLog;
  pager?: IncidentPager | undefined;
  notifier?: HoldNotifier | undefined;
  cache?: FastRevokeCache | undefined;
  audit?: AuditSink | undefined;
  /** Public base URL of the gateway: where a push's Revoke button posts. */
  publicUrl: string;
  /** Shared with the control plane: derives each person's push topic. */
  pushSecret?: string | undefined;
  now?: () => number;
}

export type RollbackTrigger = RollbackRow['trigger'];

export interface RollbackOutcome {
  rollbackId: string;
  state: 'succeeded' | 'failed' | 'nothing_to_undo';
  reversed: Array<{ compensationId: string; toolId: string; summary: string; notified: string[]; outcome: string }>;
  permanent: Array<{ compensationId: string; toolId: string; reason: string }>;
  failed?: { compensationId: string; toolId: string; error: { code: string; message: string }; incidentId: string } | undefined;
  notAttempted: Array<{ compensationId: string; toolId: string }>;
}

const WINDOWLESS_HOLD_MS = 7 * 86_400_000;

export class ReversibilityEngine {
  constructor(readonly deps: EngineDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  // ------------------------------------------------------------------ before and after the call

  /** captureCompensator (M6): MUST succeed for an R1/R2 action with an inverse, or the call does not happen. */
  async arm(ctx: StepContext): Promise<{ captured: boolean; ref?: string; holdOnly?: boolean }> {
    if (ctx.tool.reversibility === 'R0' || ctx.tool.reversibility === 'R3') return { captured: false };
    if (!ctx.connectorId) return { captured: false };
    const out = await this.deps.port.capture({ tenantId: ctx.tenantId, connectorId: ctx.connectorId, toolId: ctx.toolId, args: ctx.args, runId: ctx.runId, nodeId: `v${ctx.programVersion}.${ctx.callSeq}` });
    if (!out.ok) throw new Error(`the undo for ${ctx.toolId} could not be prepared (${out.error.code}: ${out.error.message}); it was not called`);
    if (out.kind === 'hold_only') return { captured: false, ref: out.ref, holdOnly: true };
    const id = await this.deps.store.arm(ctx.tenantId, { runId: ctx.runId, nodeId: ctx.nodeRowId, connectorId: ctx.connectorId, token: out.token, compensator: out.compensator, description: out.description });
    return { captured: true, ref: id };
  }

  /** Records the forward call's outcome on its compensation (a no-op for calls without one). */
  async bind(tenantId: string, nodeRowId: string, result: ToolResult<unknown> | 'unknown', actionId: string | null): Promise<CompensationRow | null> {
    const committed = result !== 'unknown' && result.ok;
    const forward: ForwardOutcome | null = committed ? { providerRef: result.providerRef, detail: result.effect.detail, recordsAffected: result.effect.recordsAffected } : null;
    const outcome = result === 'unknown' ? 'unknown' : result.ok ? 'committed' : 'failed';
    const row = await this.deps.store.bindForward(tenantId, nodeRowId, { outcome, forward, actionId, at: new Date(this.now()) });
    if (!row || !committed) return row;
    // The description can now name what the forward call actually created.
    const token = await this.deps.store.openToken(tenantId, row.id);
    const description = this.deps.port.describeCompensation(token);
    if (description && description !== row.description) {
      await withTenant(tenantId, (db) => db.update(schema.compensations).set({ description }).where(eq(schema.compensations.id, row.id)));
      return { ...row, description };
    }
    return row;
  }

  /** §5.7: record any divergence; ABORT means the run stops and its committed steps are compensated. */
  async diverged(ctx: StepContext, sim: SimulationResult, actual: Effect<unknown>, actionId: string | null): Promise<{ abort: boolean; message: string }> {
    if (!sim.ok || ctx.tool.reversibility === 'R0') return { abort: false, message: '' };
    const d = divergence(ctx.toolId, sim.effect, actual);
    if (d.severity === 'NONE') return { abort: false, message: '' };
    const strip = (e: Effect<unknown>) => ({ summary: e.summary, externalRecipients: e.externalRecipients, recordsAffected: e.recordsAffected, monetaryValue: e.monetaryValue ?? null, detail: e.detail });
    await this.deps.store.recordDivergence(ctx.tenantId, { runId: ctx.runId, nodeId: ctx.nodeRowId, actionId, toolId: ctx.toolId, simulated: strip(sim.effect), actual: strip(actual), divergence: d });
    const message = divergenceText(ctx.toolId, d);
    if (d.severity === 'ABORT') this.deps.log.error({ run_id: ctx.runId, tool_id: ctx.toolId, facets: d.diff.map((f) => f.name) }, `DIVERGENCE: ${message}; aborting the run`);
    return { abort: d.severity === 'ABORT', message };
  }

  // ------------------------------------------------------------------ holds

  /** Who may revoke, fixed when the hold is created (§10): the principal, the agent's owner, admins and approvers. */
  async revokers(tenantId: string, principalUserId: string, agentId: string): Promise<string[]> {
    return withTenant(tenantId, async (db) => {
      const [agent] = await db.select({ owner: schema.agents.ownerUserId }).from(schema.agents).where(eq(schema.agents.id, agentId));
      const admins = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(inArray(schema.users.role, ['OWNER', 'ADMIN', 'APPROVER']), eq(schema.users.status, 'active')));
      return [...new Set([principalUserId, ...(agent?.owner ? [agent.owner] : []), ...admins.map((a) => a.id)])];
    });
  }

  /**
   * Opens a hold: the row (idempotent per run + key), the precomputed revokers, the fast-path
   * cache, and a push to the principal with a one-tap Revoke. The capability's plaintext exists
   * only in the push; it is never a step result, a log line or a column.
   */
  async openHold(input: {
    tenantId: string;
    runId: string;
    principalUserId: string;
    agentId: string;
    nodeRowId: string;
    actionId: string | null;
    holdKey: string;
    toolId: string;
    windowMs: number | null;
    heldAt: number;
    artifact: HoldArtifact;
  }): Promise<Pick<HoldRow, 'id' | 'expiresAt' | 'state'>> {
    const existing = await this.deps.store.holdByKey(input.tenantId, input.runId, input.holdKey);
    if (existing) return { id: existing.id, expiresAt: existing.expiresAt, state: existing.state };
    const allowed = await this.revokers(input.tenantId, input.principalUserId, input.agentId);
    const expiresAt = new Date(input.heldAt + (input.windowMs ?? WINDOWLESS_HOLD_MS));
    const cap = mintRevokeToken(input.tenantId);
    const hold = await this.deps.store.createHold(input.tenantId, {
      runId: input.runId,
      nodeId: input.nodeRowId,
      actionId: input.actionId,
      holdKey: input.holdKey,
      toolId: input.toolId,
      windowMs: input.windowMs ?? 0,
      expiresAt,
      allowedRevokers: allowed,
      revokeTokenHash: cap.hash,
      artifact: input.artifact,
    });
    const entry: FastRevokeEntry = { tenantId: input.tenantId, runId: input.runId, holdId: hold.id, toolId: input.toolId, allowed, expiresAt: expiresAt.toISOString() };
    const ttl = Math.max(60_000, expiresAt.getTime() - this.now() + 3_600_000);
    await Promise.all([this.deps.cache?.set(fastRevokeKeys.hold(hold.id), JSON.stringify(entry), ttl), this.deps.cache?.set(fastRevokeKeys.token(cap.hash), hold.id, ttl)]).catch((e) =>
      this.deps.log.warn({ err: e, hold_id: hold.id }, 'fast revoke cache unavailable; revokes fall back to the database'),
    );
    if (this.deps.notifier && this.deps.pushSecret && hold.state === 'holding') {
      const summary = input.artifact.effect?.summary ?? `${input.toolId} is held`;
      await this.deps.notifier
        .notify({
          topic: pushTopic(input.principalUserId, this.deps.pushSecret),
          title: input.windowMs ? `Held — sends in ${Math.round(input.windowMs / 60_000) || 1} min` : 'Held until someone releases it',
          message: `${summary} Tap Revoke to stop it.`,
          revokeUrl: `${this.deps.publicUrl.replace(/\/$/, '')}/v1/holds/revoke`,
          revokeToken: cap.token,
          expiresAt,
        })
        .catch((e) => this.deps.log.warn({ err: e, hold_id: hold.id }, 'push notification failed; the hold is still revocable in the app'));
    }
    return { id: hold.id, expiresAt: hold.expiresAt, state: hold.state };
  }

  /**
   * The window ended (or a message arrived): settle the hold. The timer's release is a
   * compare-and-set that a person's revoke may already have won — then the revoke stands.
   * A hold that cannot be found at all is ambiguous: NEEDS_ATTENTION, never a guess (§5.5).
   */
  async settleHold(tenantId: string, holdId: string, timedOut: boolean, windowless: boolean): Promise<{ state: HoldRow['state'] | 'missing'; by: string | null }> {
    if (timedOut) {
      const r = await this.deps.store.decideHold(tenantId, holdId, windowless ? 'expired' : 'expired_released');
      if (!r.hold) return { state: 'missing', by: null };
      return { state: r.hold.state, by: r.hold.revokedBy ?? r.hold.releasedBy };
    }
    const h = await this.deps.store.hold(tenantId, holdId);
    return h ? { state: h.state, by: h.revokedBy ?? h.releasedBy } : { state: 'missing', by: null };
  }

  // ------------------------------------------------------------------ rollbacks

  /** What a rollback of these would undo, in strict reverse order of commitment (§5.8). */
  async plan(tenantId: string, input: { runId: string; scope: 'action' | 'run'; trigger: RollbackTrigger; requestedBy: string | null; requestedAt: Date; compensationId?: string | undefined }): Promise<RollbackRow> {
    const all = await this.deps.store.forRun(tenantId, input.runId);
    const now = this.now();
    const chosen = input.compensationId ? all.filter((c) => c.id === input.compensationId) : all;
    const runnable = sagaOrder(chosen.filter((c) => undoable(c, now).ok || (c.state === 'failed' && c.forwardState !== 'failed')));
    return this.deps.store.createRollback(tenantId, { runId: input.runId, scope: input.scope, trigger: input.trigger, requestedBy: input.requestedBy, requestedAt: input.requestedAt, compensationIds: runnable.map((c) => c.id) });
  }

  /**
   * Runs a planned rollback inside a durable workflow. Stops at the first compensation that
   * fails after its bounded retries: the ones before it in the order are undone, it failed, the
   * rest are NOT attempted (undoing earlier steps around a failed later one can leave the world
   * more inconsistent) — and the incident says exactly that.
   */
  async rollback(ctx: DurableContext, tenantId: string, rollbackId: string, meta: { agentId?: string | undefined; label?: string } = {}): Promise<RollbackOutcome> {
    const rb = await ctx.step(`rb:${rollbackId}:load`, async () => {
      const r = await this.deps.store.rollback(tenantId, rollbackId);
      return r ? { runId: r.runId, ids: r.compensationIds, trigger: r.trigger, requestedAt: r.requestedAt.toISOString(), state: r.state } : null;
    }, { retries: 5 });
    const out: RollbackOutcome = { rollbackId, state: 'succeeded', reversed: [], permanent: [], notAttempted: [] };
    if (!rb) return { ...out, state: 'nothing_to_undo' };
    if (!rb.ids.length) return { ...out, state: 'nothing_to_undo' };
    const channel = rb.trigger === 'user' ? 'app' : 'saga';

    for (let i = 0; i < rb.ids.length; i++) {
      const id = rb.ids[i]!;
      const row = await ctx.step(`rb:${rollbackId}:${id}:row`, async () => {
        const c = await this.deps.store.get(tenantId, id);
        return c ? { toolId: c.toolId, state: c.state, forwardState: c.forwardState, ttlAt: c.ttlAt?.toISOString() ?? null, actionId: c.actionId, connectorId: c.connectorId } : null;
      }, { retries: 5 });
      if (!row) continue;
      if (row.state === 'succeeded' || row.state === 'not_needed') continue;
      if (row.state === 'expired' || (row.ttlAt && Date.parse(row.ttlAt) <= (await ctx.now()))) {
        await ctx.step(`rb:${rollbackId}:${id}:expire`, () => this.deps.store.expireDue(tenantId, new Date()), { retries: 3 });
        out.permanent.push({ compensationId: id, toolId: row.toolId, reason: 'the undo window has passed; the action is now permanent' });
        continue;
      }
      let done = false;
      for (let attempt = 1; !done; attempt++) {
        const claimed = await ctx.step(`rb:${rollbackId}:${id}:claim:${attempt}`, async () => Boolean(await this.deps.store.claim(tenantId, id, rollbackId)), { retries: 5 });
        if (!claimed) {
          // Someone else is undoing it right now (another rollback): not ours to run.
          out.permanent.push({ compensationId: id, toolId: row.toolId, reason: 'it was being undone by another request' });
          break;
        }
        const res = await ctx.step(`rb:${rollbackId}:${id}:run:${attempt}`, async () => {
          const token = await this.deps.store.openToken(tenantId, id);
          const r = await this.deps.port.compensate({ tenantId, connectorId: row.connectorId, token, compensationId: id, runId: rb.runId });
          return r.ok ? { ok: true as const, result: r.result } : { ok: false as const, error: { code: r.error.code, message: r.error.message } };
        });
        if (res.ok) {
          await ctx.step(`rb:${rollbackId}:${id}:done`, async () => {
            await this.deps.store.finish(tenantId, id, { state: res.result.outcome === 'not_needed' ? 'not_needed' : 'succeeded', result: res.result });
            await this.deps.store.recordUndo(tenantId, { runId: rb.runId, actionId: row.actionId, toolId: row.toolId, kind: 'compensate', channel, requestedAt: new Date(rb.requestedAt), restoredAt: new Date(), succeeded: true });
            await this.deps.audit?.append({ tenantId, kind: 'compensation.succeeded', payload: { runId: rb.runId, compensationId: id, toolId: row.toolId, rollbackId, outcome: res.result.outcome, summary: res.result.summary, notified: res.result.notified } });
          }, { retries: 5 });
          out.reversed.push({ compensationId: id, toolId: row.toolId, summary: res.result.summary, notified: res.result.notified, outcome: res.result.outcome });
          done = true;
          continue;
        }
        const delay = retryable(res.error.code) ? nextDelay(attempt) : null;
        if (delay !== null) {
          await ctx.step(`rb:${rollbackId}:${id}:retry:${attempt}`, () => this.deps.store.retryLater(tenantId, id, res.error), { retries: 5 });
          await ctx.sleep(delay);
          continue;
        }
        // Bounded retries exhausted, or a failure retrying cannot fix: the incident path.
        const rest = rb.ids.slice(i + 1);
        const incidentId = await ctx.step(`rb:${rollbackId}:${id}:incident`, () => this.incident(tenantId, { compensationId: id, runId: rb.runId, rollbackId, toolId: row.toolId, actionId: row.actionId, error: res.error, reversed: out.reversed, notAttempted: rest, agentId: meta.agentId }), { retries: 5 });
        out.failed = { compensationId: id, toolId: row.toolId, error: res.error, incidentId };
        out.notAttempted = await ctx.step(`rb:${rollbackId}:rest`, async () => {
          const rows = await Promise.all(rest.map((r) => this.deps.store.get(tenantId, r)));
          return rows.filter((r): r is CompensationRow => Boolean(r)).map((r) => ({ compensationId: r.id, toolId: r.toolId }));
        }, { retries: 5 });
        out.state = 'failed';
        break;
      }
      if (out.state === 'failed') break;
    }
    await ctx.step(`rb:${rollbackId}:finish`, () => this.deps.store.finishRollback(tenantId, rollbackId, out.state === 'failed' ? 'failed' : 'succeeded', out), { retries: 5 });
    return out;
  }

  /** §5.3/§8.3: a failed compensation pages, is audited, lands in the Security Center, and asks M10 to demote. */
  private async incident(
    tenantId: string,
    f: { compensationId: string; runId: string; rollbackId: string; toolId: string; actionId: string | null; error: { code: string; message: string }; reversed: RollbackOutcome['reversed']; notAttempted: string[]; agentId?: string | undefined },
  ): Promise<string> {
    const failed = await this.deps.store.finish(tenantId, f.compensationId, { state: 'failed', error: f.error });
    const token = await this.deps.store.openToken(tenantId, f.compensationId);
    const connector = f.toolId.split('.')[0]!;
    await this.deps.store.recordUndo(tenantId, { runId: f.runId, actionId: f.actionId, toolId: f.toolId, kind: 'compensate', channel: 'saga', requestedAt: new Date(), restoredAt: null, succeeded: false });
    const title = `Could not undo ${f.toolId}: ${failed?.description ?? token.ref}`;
    const inc = await this.deps.store.openIncident(tenantId, {
      kind: 'compensation_failed',
      severity: failed?.sideEffects === 'NOTIFIES_THIRD_PARTY' ? 'CRITICAL' : 'HIGH',
      title: title.slice(0, 300),
      runId: f.runId,
      actionId: f.actionId,
      compensationId: f.compensationId,
      detail: {
        whatFailed: failed?.description ?? null,
        error: f.error,
        rollbackId: f.rollbackId,
        // The state of the world now, in the order the rollback ran.
        reversed: f.reversed.map((r) => ({ toolId: r.toolId, summary: r.summary })),
        notAttempted: f.notAttempted,
        steps: remediationSteps(token, { errorCode: f.error.code, connectorName: connector }),
      },
    });
    await withTenant(tenantId, (db) =>
      db.insert(schema.platformEvents).values({ tenantId, actorId: null, kind: 'autonomy.demotion_requested', payload: { runId: f.runId, agentId: f.agentId ?? null, reason: 'compensation_failed', incidentId: inc.id, toolId: f.toolId } }),
    );
    await this.deps.audit?.append({ tenantId, kind: 'compensation.failed', payload: { runId: f.runId, compensationId: f.compensationId, toolId: f.toolId, incidentId: inc.id, error: f.error } }).catch((e) => this.deps.log.error({ err: e }, 'audit append failed for a compensation failure'));
    await (this.deps.pager?.page({ tenantId, title: inc.title, severity: inc.severity, runId: f.runId, incidentId: inc.id }) ?? Promise.resolve()).catch((e) => this.deps.log.error({ err: e }, 'paging failed'));
    this.deps.log.error({ incident: inc.id, run_id: f.runId, tool_id: f.toolId, code: f.error.code, alert: true }, `COMPENSATION FAILED: ${inc.title}`);
    return inc.id;
  }
}
