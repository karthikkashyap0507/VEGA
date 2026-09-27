import { and, asc, desc, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { schema, withTenant, type Db } from '@vega/db';
import type { CompensationResult, CompensationToken, CompensatorInfo, ForwardOutcome } from '@vega/connector-sdk';
import type { CompensationState, ForwardState } from './lifecycle.js';
import { ttlAt } from './lifecycle.js';
import { digestOf, openJson, sealJson } from './seal.js';
import type { BlastRadiusSummary } from './blast-radius.js';
import type { Divergence } from './divergence.js';
import type { EditDiff } from './edit.js';
import type { UndoSample } from './metrics.js';

/**
 * THE REVERSIBILITY STORE — every read and write of Module 6's tables, for both planes, under
 * withTenant(). The execution plane arms, binds and runs compensations and holds the timers; the
 * control plane reads for the console and commits a person's revoke / release / edit with the
 * compare-and-set on `holds.state` that arbitrates between them and the timer (§5.5).
 *
 * Tokens and held artifacts are sealed on the way in and opened only by `openToken` /
 * `openArtifact` — which the execution plane calls to compensate or release, and nothing that
 * serves an API does. What the console shows is the stored description.
 */

export type HoldState = 'holding' | 'released' | 'revoked' | 'edited_requeued' | 'expired_released' | 'expired' | 'needs_attention';

export interface CompensationRow {
  id: string;
  tenantId: string;
  actionId: string | null;
  runId: string;
  nodeId: string;
  connectorId: string;
  toolId: string;
  compensatorRef: string;
  confidence: 'EXACT' | 'APPROXIMATE';
  sideEffects: 'SILENT' | 'NOTIFIES_THIRD_PARTY';
  description: string;
  ttlMs: number;
  forwardState: ForwardState;
  commitSeq: number | null;
  committedAt: Date | null;
  ttlAt: Date | null;
  state: CompensationState;
  attempts: number;
  rollbackId: string | null;
  executedAt: Date | null;
  result: CompensationResult | null;
  lastError: { code: string; message: string } | null;
  createdAt: Date;
}

export interface HoldArtifact {
  toolId: string;
  args: Record<string, unknown>;
  effect: { summary: string; externalRecipients: string[]; recordsAffected: unknown[]; fidelity: string; reversibilityNote?: string | undefined } | null;
  reason: string;
}

export interface HoldRow {
  id: string;
  tenantId: string;
  actionId: string | null;
  runId: string;
  nodeId: string;
  holdKey: string;
  toolId: string;
  windowMs: number;
  expiresAt: Date;
  allowedRevokers: string[];
  releasedAt: Date | null;
  releasedBy: string | null;
  revokedAt: Date | null;
  revokedBy: string | null;
  revokeReason: string | null;
  revokeChannel: 'app' | 'push' | null;
  edited: boolean;
  editDiff: EditDiff | null;
  requestedAt: Date | null;
  state: HoldState;
  createdAt: Date;
}

export interface RollbackRow {
  id: string;
  runId: string;
  scope: 'action' | 'run';
  trigger: 'user' | 'run_failure' | 'divergence' | 'verification';
  requestedBy: string | null;
  requestedAt: Date;
  state: 'running' | 'succeeded' | 'failed' | 'nothing_to_undo';
  compensationIds: string[];
  finishedAt: Date | null;
  summary: unknown;
}

export interface IncidentRow {
  id: string;
  kind: 'compensation_failed' | 'hold_ambiguous' | 'divergence_abort';
  severity: 'HIGH' | 'CRITICAL';
  title: string;
  runId: string | null;
  actionId: string | null;
  compensationId: string | null;
  detail: Record<string, unknown>;
  state: 'open' | 'acknowledged' | 'resolved';
  createdAt: Date;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolution: string | null;
}

const toCompensation = (r: typeof schema.compensations.$inferSelect): CompensationRow => ({
  id: r.id,
  tenantId: r.tenantId,
  actionId: r.actionId,
  runId: r.runId,
  nodeId: r.nodeId,
  connectorId: r.connectorId,
  toolId: r.toolId,
  compensatorRef: r.compensatorRef,
  confidence: r.confidence as CompensationRow['confidence'],
  sideEffects: r.sideEffects as CompensationRow['sideEffects'],
  description: r.description,
  ttlMs: Number(r.ttlMs),
  forwardState: r.forwardState as ForwardState,
  commitSeq: r.commitSeq === null ? null : Number(r.commitSeq),
  committedAt: r.committedAt,
  ttlAt: r.ttlAt,
  state: r.state as CompensationState,
  attempts: r.attempts,
  rollbackId: r.rollbackId,
  executedAt: r.executedAt,
  result: (r.resultJson ?? null) as CompensationResult | null,
  lastError: (r.lastError ?? null) as CompensationRow['lastError'],
  createdAt: r.createdAt,
});

const toHold = (r: typeof schema.holds.$inferSelect): HoldRow => ({
  id: r.id,
  tenantId: r.tenantId,
  actionId: r.actionId,
  runId: r.runId,
  nodeId: r.nodeId,
  holdKey: r.holdKey,
  toolId: r.toolId,
  windowMs: r.windowMs,
  expiresAt: r.expiresAt,
  allowedRevokers: r.allowedRevokers,
  releasedAt: r.releasedAt,
  releasedBy: r.releasedBy,
  revokedAt: r.revokedAt,
  revokedBy: r.revokedBy,
  revokeReason: r.revokeReason,
  revokeChannel: r.revokeChannel as HoldRow['revokeChannel'],
  edited: r.edited,
  editDiff: (r.editDiff ?? null) as EditDiff | null,
  requestedAt: r.requestedAt,
  state: r.state as HoldState,
  createdAt: r.createdAt,
});

const toRollback = (r: typeof schema.rollbacks.$inferSelect): RollbackRow => ({
  id: r.id,
  runId: r.runId,
  scope: r.scope as RollbackRow['scope'],
  trigger: r.trigger as RollbackRow['trigger'],
  requestedBy: r.requestedBy,
  requestedAt: r.requestedAt,
  state: r.state as RollbackRow['state'],
  compensationIds: r.compensationIds,
  finishedAt: r.finishedAt,
  summary: r.summaryJson,
});

const toIncident = (r: typeof schema.incidents.$inferSelect): IncidentRow => ({
  id: r.id,
  kind: r.kind as IncidentRow['kind'],
  severity: r.severity as IncidentRow['severity'],
  title: r.title,
  runId: r.runId,
  actionId: r.actionId,
  compensationId: r.compensationId,
  detail: (r.detailJson ?? {}) as Record<string, unknown>,
  state: r.state as IncidentRow['state'],
  createdAt: r.createdAt,
  acknowledgedBy: r.acknowledgedBy,
  acknowledgedAt: r.acknowledgedAt,
  resolvedBy: r.resolvedBy,
  resolvedAt: r.resolvedAt,
  resolution: r.resolution,
});

async function event(db: Db, tenantId: string, kind: string, payload: Record<string, unknown>, actorId: string | null = null) {
  await db.insert(schema.platformEvents).values({ tenantId, actorId, kind, payload });
}

export class ReversibilityStore {
  constructor(private readonly kek?: Buffer) {}

  // ------------------------------------------------------------------ compensations

  /**
   * Arms a compensation with the token captured BEFORE the call. A call captured again (the
   * step re-ran after a crash, before the provider heard anything) replaces its own token;
   * once the forward call has an outcome, the token is never replaced.
   */
  async arm(
    tenantId: string,
    input: { runId: string; nodeId: string; connectorId: string; token: CompensationToken; compensator: CompensatorInfo; description: string },
  ): Promise<string> {
    const values = {
      tenantId,
      runId: input.runId,
      nodeId: input.nodeId,
      connectorId: input.connectorId,
      toolId: input.token.toolId,
      compensatorRef: input.compensator.ref,
      tokenSealed: sealJson(input.token, this.kek),
      tokenDigest: digestOf(input.token),
      confidence: input.compensator.confidence,
      sideEffects: input.compensator.sideEffects,
      description: input.description,
      ttlMs: input.compensator.ttlMs,
    };
    return withTenant(tenantId, async (db) => {
      const [row] = await db
        .insert(schema.compensations)
        .values(values)
        .onConflictDoUpdate({
          target: schema.compensations.nodeId,
          set: { tokenSealed: values.tokenSealed, tokenDigest: values.tokenDigest, description: values.description, connectorId: values.connectorId },
          setWhere: eq(schema.compensations.forwardState, 'pending'),
        })
        .returning({ id: schema.compensations.id });
      if (row) return row.id;
      const [existing] = await db.select({ id: schema.compensations.id }).from(schema.compensations).where(eq(schema.compensations.nodeId, input.nodeId));
      return existing!.id;
    });
  }

  /**
   * Records what the forward call did. Committed (or unknown: it may have happened) starts the
   * TTL and takes the next commit sequence number — the saga's order. A call that provably did
   * nothing makes its compensation `not_needed`. Idempotent: a second bind changes nothing.
   */
  async bindForward(
    tenantId: string,
    nodeId: string,
    input: { outcome: Exclude<ForwardState, 'pending'>; forward: ForwardOutcome | null; actionId?: string | null | undefined; description?: string | undefined; at?: Date | undefined },
  ): Promise<CompensationRow | null> {
    return withTenant(tenantId, async (db) => {
      const [row] = await db.select().from(schema.compensations).where(eq(schema.compensations.nodeId, nodeId));
      if (!row) return null;
      if (row.forwardState !== 'pending') return toCompensation(row);
      const token = { ...openJson<CompensationToken>(row.tokenSealed, this.kek), forward: input.forward };
      const at = input.at ?? new Date();
      const happened = input.outcome !== 'failed';
      const [updated] = await db
        .update(schema.compensations)
        .set({
          forwardState: input.outcome,
          tokenSealed: sealJson(token, this.kek),
          tokenDigest: digestOf(token),
          ...(input.actionId ? { actionId: input.actionId } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(happened ? { committedAt: at, ttlAt: ttlAt(at, Number(row.ttlMs)), commitSeq: sql`nextval('compensation_commit_seq')` } : { state: 'not_needed' }),
        })
        .where(and(eq(schema.compensations.id, row.id), eq(schema.compensations.forwardState, 'pending')))
        .returning();
      return toCompensation(updated ?? row);
    });
  }

  async get(tenantId: string, id: string): Promise<CompensationRow | null> {
    const [row] = await withTenant(tenantId, (db) => db.select().from(schema.compensations).where(eq(schema.compensations.id, id)));
    return row ? toCompensation(row) : null;
  }

  async byAction(tenantId: string, actionId: string): Promise<CompensationRow | null> {
    const [row] = await withTenant(tenantId, (db) => db.select().from(schema.compensations).where(eq(schema.compensations.actionId, actionId)));
    return row ? toCompensation(row) : null;
  }

  async byNode(tenantId: string, nodeId: string): Promise<CompensationRow | null> {
    const [row] = await withTenant(tenantId, (db) => db.select().from(schema.compensations).where(eq(schema.compensations.nodeId, nodeId)));
    return row ? toCompensation(row) : null;
  }

  /** A run's compensations, most recently committed first (the order a rollback runs in). */
  async forRun(tenantId: string, runId: string): Promise<CompensationRow[]> {
    const rows = await withTenant(tenantId, (db) =>
      db.select().from(schema.compensations).where(eq(schema.compensations.runId, runId)).orderBy(sql`${schema.compensations.commitSeq} DESC NULLS FIRST`, desc(schema.compensations.createdAt)),
    );
    return rows.map(toCompensation);
  }

  /** Execution plane only: the token, to run the compensator. */
  async openToken(tenantId: string, id: string): Promise<CompensationToken> {
    const [row] = await withTenant(tenantId, (db) => db.select({ t: schema.compensations.tokenSealed }).from(schema.compensations).where(eq(schema.compensations.id, id)));
    if (!row) throw new Error('compensation not found');
    return openJson<CompensationToken>(row.t, this.kek);
  }

  /** Compare-and-set armed|failed → executing: exactly one worker runs a compensation. */
  async claim(tenantId: string, id: string, rollbackId: string): Promise<CompensationRow | null> {
    return withTenant(tenantId, async (db) => {
      const [row] = await db
        .update(schema.compensations)
        .set({ state: 'executing', attempts: sql`${schema.compensations.attempts} + 1`, rollbackId })
        .where(and(eq(schema.compensations.id, id), inArray(schema.compensations.state, ['armed', 'failed'])))
        .returning();
      if (row) await event(db, tenantId, 'compensation.started', { runId: row.runId, compensationId: row.id, toolId: row.toolId, attempt: row.attempts, rollbackId });
      return row ? toCompensation(row) : null;
    });
  }

  /** A failed attempt that will be retried: back to armed, with the error kept. */
  async retryLater(tenantId: string, id: string, error: { code: string; message: string }): Promise<void> {
    await withTenant(tenantId, (db) =>
      db.update(schema.compensations).set({ state: 'armed', lastError: error }).where(and(eq(schema.compensations.id, id), eq(schema.compensations.state, 'executing'))),
    );
  }

  async finish(tenantId: string, id: string, outcome: { state: 'succeeded' | 'not_needed'; result: CompensationResult } | { state: 'failed'; error: { code: string; message: string } }): Promise<CompensationRow | null> {
    return withTenant(tenantId, async (db) => {
      const [row] = await db
        .update(schema.compensations)
        .set(
          outcome.state === 'failed'
            ? { state: 'failed', lastError: outcome.error, executedAt: new Date() }
            : { state: outcome.state, resultJson: outcome.result, executedAt: new Date(), lastError: null },
        )
        .where(and(eq(schema.compensations.id, id), eq(schema.compensations.state, 'executing')))
        .returning();
      if (!row) return null;
      if (outcome.state !== 'failed') {
        if (row.actionId) await db.update(schema.actions).set({ state: 'COMPENSATED' }).where(eq(schema.actions.id, row.actionId));
        await db.update(schema.taskNodes).set({ status: 'compensated' }).where(eq(schema.taskNodes.id, row.nodeId));
        await event(db, tenantId, 'compensation.succeeded', { runId: row.runId, compensationId: row.id, toolId: row.toolId, outcome: outcome.result.outcome, summary: outcome.result.summary, notified: outcome.result.notified });
      } else {
        await event(db, tenantId, 'compensation.failed', { runId: row.runId, compensationId: row.id, toolId: row.toolId, error: outcome.error });
      }
      return toCompensation(row);
    });
  }

  /** Armed compensations whose provider window has closed become `expired`: the action is permanent. */
  async expireDue(tenantId: string, now = new Date()): Promise<number> {
    const rows = await withTenant(tenantId, (db) =>
      db
        .update(schema.compensations)
        .set({ state: 'expired' })
        .where(and(eq(schema.compensations.state, 'armed'), isNotNull(schema.compensations.ttlAt), lte(schema.compensations.ttlAt, now)))
        .returning({ id: schema.compensations.id }),
    );
    return rows.length;
  }

  // ------------------------------------------------------------------ rollbacks

  async createRollback(
    tenantId: string,
    input: { runId: string; scope: RollbackRow['scope']; trigger: RollbackRow['trigger']; requestedBy: string | null; requestedAt: Date; compensationIds: string[] },
  ): Promise<RollbackRow> {
    return withTenant(tenantId, async (db) => {
      const [row] = await db
        .insert(schema.rollbacks)
        .values({ tenantId, runId: input.runId, scope: input.scope, trigger: input.trigger, requestedBy: input.requestedBy, requestedAt: input.requestedAt, compensationIds: input.compensationIds, state: input.compensationIds.length ? 'running' : 'nothing_to_undo', ...(input.compensationIds.length ? {} : { finishedAt: new Date() }) })
        .returning();
      await event(db, tenantId, 'rollback.requested', { runId: input.runId, rollbackId: row!.id, scope: input.scope, trigger: input.trigger, compensations: input.compensationIds.length }, input.requestedBy);
      return toRollback(row!);
    });
  }

  async finishRollback(tenantId: string, id: string, state: 'succeeded' | 'failed', summary: unknown): Promise<void> {
    await withTenant(tenantId, async (db) => {
      const [row] = await db.update(schema.rollbacks).set({ state, summaryJson: summary, finishedAt: new Date() }).where(and(eq(schema.rollbacks.id, id), eq(schema.rollbacks.state, 'running'))).returning();
      if (row) await event(db, tenantId, `rollback.${state}`, { runId: row.runId, rollbackId: row.id, summary });
    });
  }

  async rollback(tenantId: string, id: string): Promise<RollbackRow | null> {
    const [row] = await withTenant(tenantId, (db) => db.select().from(schema.rollbacks).where(eq(schema.rollbacks.id, id)));
    return row ? toRollback(row) : null;
  }

  async rollbacksFor(tenantId: string, runId: string): Promise<RollbackRow[]> {
    const rows = await withTenant(tenantId, (db) => db.select().from(schema.rollbacks).where(eq(schema.rollbacks.runId, runId)).orderBy(desc(schema.rollbacks.requestedAt)));
    return rows.map(toRollback);
  }

  // ------------------------------------------------------------------ holds

  /** Idempotent per (run, key): a replayed workflow step finds the hold it created. */
  async createHold(
    tenantId: string,
    input: { runId: string; nodeId: string; actionId: string | null; holdKey: string; toolId: string; windowMs: number; expiresAt: Date; allowedRevokers: string[]; revokeTokenHash: string | null; artifact: HoldArtifact },
  ): Promise<HoldRow> {
    return withTenant(tenantId, async (db) => {
      const [row] = await db
        .insert(schema.holds)
        .values({
          tenantId,
          runId: input.runId,
          nodeId: input.nodeId,
          actionId: input.actionId,
          holdKey: input.holdKey,
          toolId: input.toolId,
          windowMs: input.windowMs,
          expiresAt: input.expiresAt,
          allowedRevokers: input.allowedRevokers,
          revokeTokenHash: input.revokeTokenHash,
          artifactRef: 'sealed:holds.artifact_sealed',
          artifactSealed: sealJson(input.artifact, this.kek),
        })
        .onConflictDoNothing({ target: [schema.holds.runId, schema.holds.holdKey] })
        .returning();
      if (row) {
        await event(db, tenantId, 'action.held', { runId: input.runId, holdId: row.id, actionId: input.actionId, toolId: input.toolId, windowMs: input.windowMs, expiresAt: input.expiresAt.toISOString(), summary: input.artifact.effect?.summary ?? null });
        return toHold(row);
      }
      const [existing] = await db.select().from(schema.holds).where(and(eq(schema.holds.runId, input.runId), eq(schema.holds.holdKey, input.holdKey)));
      return toHold(existing!);
    });
  }

  async hold(tenantId: string, id: string): Promise<HoldRow | null> {
    const [row] = await withTenant(tenantId, (db) => db.select().from(schema.holds).where(eq(schema.holds.id, id)));
    return row ? toHold(row) : null;
  }

  async holdByKey(tenantId: string, runId: string, holdKey: string): Promise<HoldRow | null> {
    const [row] = await withTenant(tenantId, (db) => db.select().from(schema.holds).where(and(eq(schema.holds.runId, runId), eq(schema.holds.holdKey, holdKey))));
    return row ? toHold(row) : null;
  }

  async holdByTokenHash(tenantId: string, hash: string): Promise<HoldRow | null> {
    const [row] = await withTenant(tenantId, (db) => db.select().from(schema.holds).where(eq(schema.holds.revokeTokenHash, hash)));
    return row ? toHold(row) : null;
  }

  async holds(tenantId: string, filter: { runId?: string | undefined; states?: HoldState[] | undefined; limit?: number | undefined } = {}): Promise<HoldRow[]> {
    const rows = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.holds)
        .where(and(filter.runId ? eq(schema.holds.runId, filter.runId) : undefined, filter.states?.length ? inArray(schema.holds.state, filter.states) : undefined))
        .orderBy(desc(schema.holds.createdAt))
        .limit(filter.limit ?? 100),
    );
    return rows.map(toHold);
  }

  /** The held content. Callers check that the reader may revoke it first (§10). */
  async openArtifact(tenantId: string, id: string): Promise<{ artifact: HoldArtifact; editedArgs: Record<string, unknown> | null }> {
    const [row] = await withTenant(tenantId, (db) => db.select({ a: schema.holds.artifactSealed, e: schema.holds.editedArgsSealed }).from(schema.holds).where(eq(schema.holds.id, id)));
    if (!row) throw new Error('hold not found');
    return { artifact: openJson<HoldArtifact>(row.a, this.kek), editedArgs: row.e ? openJson<Record<string, unknown>>(row.e, this.kek) : null };
  }

  /**
   * THE ARBITER (§5.5): moves a hold out of `holding` exactly once. A revoke and the timer race;
   * whichever commits first wins, and the other finds the hold decided. Returns the row either
   * way — `won` says whether THIS decision was the one that happened.
   */
  async decideHold(
    tenantId: string,
    id: string,
    to: Exclude<HoldState, 'holding'>,
    patch: { by?: string | null | undefined; channel?: 'app' | 'push' | undefined; reason?: string | undefined; requestedAt?: Date | undefined; editDiff?: EditDiff | undefined; editedArgs?: Record<string, unknown> | undefined } = {},
  ): Promise<{ won: boolean; hold: HoldRow | null }> {
    return withTenant(tenantId, async (db) => {
      const now = new Date();
      const set: Partial<typeof schema.holds.$inferInsert> = { state: to, ...(patch.requestedAt ? { requestedAt: patch.requestedAt } : {}) };
      if (to === 'revoked') Object.assign(set, { revokedAt: now, revokedBy: patch.by ?? null, revokeReason: patch.reason ?? null, revokeChannel: patch.channel ?? 'app' });
      if (to === 'released' || to === 'expired_released') Object.assign(set, { releasedAt: now, releasedBy: to === 'expired_released' ? 'timer' : (patch.by ?? null) });
      if (to === 'edited_requeued') Object.assign(set, { edited: true, editDiff: patch.editDiff ?? null, editedArgsSealed: patch.editedArgs ? sealJson(patch.editedArgs, this.kek) : null });
      const [row] = await db.update(schema.holds).set(set).where(and(eq(schema.holds.id, id), eq(schema.holds.state, 'holding'))).returning();
      if (row) {
        const kind = to === 'revoked' ? 'action.revoked' : to === 'released' || to === 'expired_released' ? 'action.released' : to === 'edited_requeued' ? 'action.edited' : `action.hold_${to}`;
        await event(db, tenantId, kind, { runId: row.runId, holdId: row.id, actionId: row.actionId, toolId: row.toolId, by: patch.by ?? null, channel: patch.channel ?? null, early: to === 'released' }, to === 'revoked' || to === 'released' || to === 'edited_requeued' ? (patch.by ?? null) : null);
        if (row.actionId && to === 'revoked') await db.update(schema.actions).set({ state: 'REVOKED' }).where(eq(schema.actions.id, row.actionId));
        return { won: true, hold: toHold(row) };
      }
      const [current] = await db.select().from(schema.holds).where(eq(schema.holds.id, id));
      return { won: false, hold: current ? toHold(current) : null };
    });
  }

  // ------------------------------------------------------------------ blast radius

  async saveBlastRadius(tenantId: string, input: { runId: string; programVersion: number; programDigest: string; effects: unknown; summary: BlastRadiusSummary }): Promise<string> {
    const [row] = await withTenant(tenantId, (db) =>
      db
        .insert(schema.blastRadius)
        .values({ tenantId, runId: input.runId, programVersion: input.programVersion, programDigest: input.programDigest, effectsJson: input.effects, summaryJson: input.summary, minFidelity: input.summary.minFidelity })
        .returning({ id: schema.blastRadius.id }),
    );
    return row!.id;
  }

  async latestBlastRadius(tenantId: string, runId: string): Promise<{ id: string; programVersion: number; programDigest: string; summary: BlastRadiusSummary; computedAt: Date } | null> {
    const [row] = await withTenant(tenantId, (db) => db.select().from(schema.blastRadius).where(eq(schema.blastRadius.runId, runId)).orderBy(desc(schema.blastRadius.computedAt)).limit(1));
    return row ? { id: row.id, programVersion: row.programVersion, programDigest: row.programDigest, summary: row.summaryJson as BlastRadiusSummary, computedAt: row.computedAt } : null;
  }

  // ------------------------------------------------------------------ divergences

  async recordDivergence(tenantId: string, input: { runId: string; nodeId: string; actionId: string | null; toolId: string; simulated: unknown; actual: unknown; divergence: Divergence }): Promise<void> {
    if (input.divergence.severity === 'NONE') return;
    const severity = input.divergence.severity;
    await withTenant(tenantId, async (db) => {
      await db.insert(schema.divergences).values({ tenantId, runId: input.runId, nodeId: input.nodeId, actionId: input.actionId, toolId: input.toolId, simulatedJson: input.simulated, actualJson: input.actual, diffJson: input.divergence.diff, severity });
      await event(db, tenantId, 'divergence.detected', { runId: input.runId, nodeId: input.nodeId, toolId: input.toolId, severity, facets: input.divergence.diff.map((f) => f.name) });
    });
  }

  async divergences(tenantId: string, filter: { toolId?: string | undefined; since?: Date | undefined; limit?: number | undefined } = {}) {
    return withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.divergences)
        .where(and(filter.toolId ? eq(schema.divergences.toolId, filter.toolId) : undefined, filter.since ? gte(schema.divergences.createdAt, filter.since) : undefined))
        .orderBy(desc(schema.divergences.createdAt))
        .limit(filter.limit ?? 100),
    );
  }

  /** Divergence rate per tool (§5.7): a rising rate means a simulation has drifted from its provider. */
  async divergenceRates(tenantId: string, since: Date): Promise<Array<{ toolId: string; actions: number; divergences: number; aborts: number }>> {
    return withTenant(tenantId, async (db) => {
      const acts = await db
        .select({ toolId: schema.actions.toolId, n: sql<number>`count(*)::int` })
        .from(schema.actions)
        .where(and(gte(schema.actions.createdAt, since), inArray(schema.actions.state, ['COMMITTED', 'COMPENSATED'])))
        .groupBy(schema.actions.toolId);
      const divs = await db
        .select({ toolId: schema.divergences.toolId, n: sql<number>`count(*)::int`, aborts: sql<number>`count(*) FILTER (WHERE severity = 'ABORT')::int` })
        .from(schema.divergences)
        .where(gte(schema.divergences.createdAt, since))
        .groupBy(schema.divergences.toolId);
      const tools = new Set([...acts.map((a) => a.toolId), ...divs.map((d) => d.toolId)]);
      return [...tools].sort().map((toolId) => ({
        toolId,
        actions: acts.find((a) => a.toolId === toolId)?.n ?? 0,
        divergences: divs.find((d) => d.toolId === toolId)?.n ?? 0,
        aborts: divs.find((d) => d.toolId === toolId)?.aborts ?? 0,
      }));
    });
  }

  // ------------------------------------------------------------------ Time-to-Undo

  async recordUndo(
    tenantId: string,
    input: { runId: string; actionId: string | null; toolId: string; kind: 'revoke' | 'compensate'; channel: 'app' | 'push' | 'saga'; requestedAt: Date; restoredAt: Date | null; succeeded: boolean },
  ): Promise<void> {
    const duration = input.restoredAt ? Math.max(0, input.restoredAt.getTime() - input.requestedAt.getTime()) : null;
    await withTenant(tenantId, (db) =>
      db.insert(schema.undoMetrics).values({ tenantId, runId: input.runId, actionId: input.actionId, toolId: input.toolId, kind: input.kind, channel: input.channel, requestedAt: input.requestedAt, restoredAt: input.restoredAt, durationMs: duration, succeeded: input.succeeded }),
    );
  }

  async undoSamples(tenantId: string, since: Date): Promise<UndoSample[]> {
    const rows = await withTenant(tenantId, (db) => db.select().from(schema.undoMetrics).where(gte(schema.undoMetrics.requestedAt, since)).orderBy(asc(schema.undoMetrics.requestedAt)));
    return rows.map((r) => ({ toolId: r.toolId, kind: r.kind as UndoSample['kind'], durationMs: r.durationMs, succeeded: r.succeeded, requestedAt: r.requestedAt }));
  }

  // ------------------------------------------------------------------ incidents

  async openIncident(
    tenantId: string,
    input: { kind: IncidentRow['kind']; severity: IncidentRow['severity']; title: string; runId?: string | null | undefined; actionId?: string | null | undefined; compensationId?: string | null | undefined; detail: Record<string, unknown> },
  ): Promise<IncidentRow> {
    return withTenant(tenantId, async (db) => {
      const [row] = await db
        .insert(schema.incidents)
        .values({ tenantId, kind: input.kind, severity: input.severity, title: input.title, runId: input.runId ?? null, actionId: input.actionId ?? null, compensationId: input.compensationId ?? null, detailJson: input.detail })
        .returning();
      await event(db, tenantId, 'incident.opened', { incidentId: row!.id, kind: input.kind, severity: input.severity, title: input.title, runId: input.runId ?? null });
      return toIncident(row!);
    });
  }

  async incidents(tenantId: string, filter: { states?: IncidentRow['state'][] | undefined; runId?: string | undefined; limit?: number | undefined } = {}): Promise<IncidentRow[]> {
    const rows = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.incidents)
        .where(and(filter.states?.length ? inArray(schema.incidents.state, filter.states) : undefined, filter.runId ? eq(schema.incidents.runId, filter.runId) : undefined))
        .orderBy(desc(schema.incidents.createdAt))
        .limit(filter.limit ?? 100),
    );
    return rows.map(toIncident);
  }

  async incident(tenantId: string, id: string): Promise<IncidentRow | null> {
    const [row] = await withTenant(tenantId, (db) => db.select().from(schema.incidents).where(eq(schema.incidents.id, id)));
    return row ? toIncident(row) : null;
  }

  async updateIncident(tenantId: string, id: string, to: 'acknowledged' | 'resolved', by: string, resolution?: string): Promise<IncidentRow | null> {
    return withTenant(tenantId, async (db) => {
      const now = new Date();
      const [row] = await db
        .update(schema.incidents)
        .set(to === 'acknowledged' ? { state: 'acknowledged', acknowledgedBy: by, acknowledgedAt: now } : { state: 'resolved', resolvedBy: by, resolvedAt: now, resolution: resolution ?? null })
        .where(and(eq(schema.incidents.id, id), inArray(schema.incidents.state, to === 'acknowledged' ? ['open'] : ['open', 'acknowledged'])))
        .returning();
      if (row) await event(db, tenantId, `incident.${to}`, { incidentId: id, runId: row.runId }, by);
      return row ? toIncident(row) : null;
    });
  }
}
