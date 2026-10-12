import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { schema, withTenant, type Db } from '@vega/db';
import type { Role } from '@vega/authz';
import type { FieldChange } from './diff.js';
import type { DecisionPacket, Fallback } from './packet.js';
import type { DelegationRow, Person } from './routing.js';

/**
 * THE APPROVAL STORE — every read and write of Module 8's tables, for both planes, under
 * withTenant(). The execution plane OPENS a request (packet rendered and hashed) and SETTLES it
 * when its timers fire (escalate, expire → fallback); the control plane DECIDES on it. Both go
 * through a row lock and a state check, so whichever commits first is what happened.
 *
 * The decision and its corpus row (approval_decisions) are written in ONE transaction: a decision
 * without its telemetry cannot exist (§13 "a dropped telemetry row is lost forever").
 */

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'escalated' | 'superseded' | 'cancelled';
export type Surface = 'web' | 'mobile' | 'email' | 'push' | 'system';
export type HumanDecision = 'approve' | 'approve_with_edits' | 'reject';

export type RequestRow = typeof schema.approvalRequests.$inferSelect;
export type DecisionRow = typeof schema.approvalDecisions.$inferSelect;

export interface OpenInput {
  runId: string;
  nodeId: string;
  actionId: string | null;
  approvalKey: string;
  toolId: string;
  requester: string;
  approverRole: string;
  assignedTo: string | null;
  delegatedFrom: string | null;
  escalateAt: Date | null;
  packet: DecisionPacket;
  packetDigest: string;
  riskTier: string | null;
  urgency: 'normal' | 'urgent';
  approvalsRequired: number;
  separationOfDuties: boolean;
  expiresAt: Date;
  fallback: Fallback;
  fallbackRole: string | null;
  rejectTokenHash: string | null;
  escalationLevel?: number;
  /** When it was opened (the orchestrator's clock: expiry windows are measured from it). */
  createdAt?: Date;
}

export interface Telemetry {
  latencyMs: number;
  evidenceOpened: boolean;
  evidenceDwellMs: number | null;
  surface: Surface;
  packetChars: number;
}

export class ApprovalError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'NOT_PENDING' | 'EXPIRED' | 'STALE_PACKET' | 'DUPLICATE_APPROVER' | 'SEPARATION_OF_DUTIES' | 'QUESTION_USED',
    message: string,
  ) {
    super(message);
  }
}

const lock = async (db: Db, id: string): Promise<RequestRow | undefined> => (await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, id)).for('update'))[0];

export class ApprovalStore {
  // ------------------------------------------------------------------ the execution plane
  /** Idempotent per (run, key): a re-run pass finds the request it opened before. */
  async open(tenantId: string, i: OpenInput): Promise<RequestRow> {
    return withTenant(tenantId, async (db) => {
      const [existing] = await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.runId, i.runId), eq(schema.approvalRequests.approvalKey, i.approvalKey))).orderBy(desc(schema.approvalRequests.createdAt)).limit(1);
      if (existing && existing.state !== 'superseded' && existing.state !== 'escalated') return existing;
      const [row] = await db
        .insert(schema.approvalRequests)
        .values({
          tenantId,
          runId: i.runId,
          nodeId: i.nodeId,
          actionId: i.actionId,
          approvalKey: i.approvalKey,
          toolId: i.toolId,
          requester: i.requester,
          approverRole: i.approverRole,
          assignedTo: i.assignedTo,
          delegatedFrom: i.delegatedFrom,
          escalateAt: i.escalateAt,
          escalationLevel: i.escalationLevel ?? 0,
          packetJson: i.packet,
          packetDigest: i.packetDigest,
          riskTier: i.riskTier,
          urgency: i.urgency,
          requiresDual: i.approvalsRequired > 1,
          approvalsRequired: i.approvalsRequired,
          separationOfDuties: i.separationOfDuties,
          expiresAt: i.expiresAt,
          fallback: i.fallback,
          fallbackRole: i.fallbackRole,
          rejectTokenHash: i.rejectTokenHash,
          ...(i.createdAt ? { createdAt: i.createdAt } : {}),
        })
        .returning();
      return row!;
    });
  }

  /**
   * The executor's timers (§5.4, §8.2). Expired → the declared fallback, recorded as an EXPIRY
   * (never as an approval by anyone); past the escalation point → the next person up.
   */
  async settle(tenantId: string, id: string, now: Date, escalateTo?: (row: RequestRow) => Promise<{ role: string; assignedTo: string | null } | null>): Promise<RequestRow> {
    return withTenant(tenantId, async (db) => {
      const r = await lock(db, id);
      if (!r) throw new ApprovalError('NOT_FOUND', 'approval request not found');
      if (r.state !== 'pending') return r;
      if (now >= r.expiresAt) {
        const state: ApprovalState = r.fallback === 'AUTO_APPROVE' ? 'approved' : r.fallback === 'ESCALATE' ? 'escalated' : 'expired';
        await db.insert(schema.approvalDecisions).values({ tenantId, requestId: r.id, runId: r.runId, actionId: r.actionId, toolId: r.toolId, approverId: null, approverRole: null, decision: 'expired', reason: `no decision before ${r.expiresAt.toISOString()}; fallback ${r.fallback}`, latencyMs: Math.max(0, now.getTime() - r.createdAt.getTime()), evidenceOpened: false, surface: 'system', packetDigest: r.packetDigest, packetChars: 0, riskTier: r.riskTier });
        const [u] = await db.update(schema.approvalRequests).set({ state, resolution: `fallback:${r.fallback}`, resolvedBy: 'system:expiry', resolvedAt: now }).where(eq(schema.approvalRequests.id, r.id)).returning();
        return u!;
      }
      if (r.escalateAt && now >= r.escalateAt && escalateTo) {
        const next = await escalateTo(r);
        const [u] = await db
          .update(schema.approvalRequests)
          .set(next ? { approverRole: next.role, assignedTo: next.assignedTo, delegatedFrom: null, escalationLevel: r.escalationLevel + 1, escalateAt: null, notifiedAt: null, batchId: null } : { escalateAt: null })
          .where(eq(schema.approvalRequests.id, r.id))
          .returning();
        if (next) await db.insert(schema.approvalDecisions).values({ tenantId, requestId: r.id, runId: r.runId, actionId: r.actionId, toolId: r.toolId, approverId: null, approverRole: next.role, decision: 'escalated', reason: `unanswered after ${Math.round((now.getTime() - r.createdAt.getTime()) / 60_000)} min; routed to ${next.role}`, latencyMs: Math.max(0, now.getTime() - r.createdAt.getTime()), evidenceOpened: false, surface: 'system', packetDigest: r.packetDigest, packetChars: 0, riskTier: r.riskTier });
        return u!;
      }
      return r;
    });
  }

  async cancelPending(tenantId: string, runId: string, reason: string): Promise<number> {
    return withTenant(tenantId, async (db) => (await db.update(schema.approvalRequests).set({ state: 'cancelled', resolution: reason, resolvedAt: new Date() }).where(and(eq(schema.approvalRequests.runId, runId), eq(schema.approvalRequests.state, 'pending'))).returning({ id: schema.approvalRequests.id })).length);
  }

  // ------------------------------------------------------------------ reads
  async get(tenantId: string, id: string): Promise<RequestRow | null> {
    return withTenant(tenantId, async (db) => (await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, id)))[0] ?? null);
  }

  async forRun(tenantId: string, runId: string): Promise<RequestRow[]> {
    return withTenant(tenantId, (db) => db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.runId, runId)).orderBy(desc(schema.approvalRequests.createdAt)));
  }

  async pending(tenantId: string): Promise<RequestRow[]> {
    return withTenant(tenantId, (db) => db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.state, 'pending')).orderBy(schema.approvalRequests.expiresAt));
  }

  async decisions(tenantId: string, requestId: string): Promise<DecisionRow[]> {
    return withTenant(tenantId, (db) => db.select().from(schema.approvalDecisions).where(eq(schema.approvalDecisions.requestId, requestId)).orderBy(schema.approvalDecisions.createdAt));
  }

  async decisionsSince(tenantId: string, since: Date): Promise<DecisionRow[]> {
    return withTenant(tenantId, (db) => db.select().from(schema.approvalDecisions).where(gte(schema.approvalDecisions.createdAt, since)));
  }

  async people(tenantId: string): Promise<Person[]> {
    return withTenant(tenantId, async (db) => (await db.select({ id: schema.users.id, role: schema.users.role, status: schema.users.status, email: schema.users.email }).from(schema.users)).map((u) => ({ ...u, role: u.role as Role })));
  }

  async delegations(tenantId: string, opts: { activeAt?: Date } = {}): Promise<DelegationRow[]> {
    return withTenant(tenantId, async (db) => {
      const rows = await db.select().from(schema.delegations).where(isNull(schema.delegations.revokedAt));
      return rows.filter((d) => !opts.activeAt || (d.startsAt <= opts.activeAt && opts.activeAt < d.endsAt));
    });
  }

  // ------------------------------------------------------------------ instrumentation (§6.2)
  async recordView(tenantId: string, v: { requestId: string; userId: string; kind: 'packet' | 'evidence'; dwellMs?: number | null; surface?: Surface; at?: Date }): Promise<void> {
    await withTenant(tenantId, (db) => db.insert(schema.approvalViews).values({ tenantId, requestId: v.requestId, userId: v.userId, kind: v.kind, dwellMs: v.dwellMs ?? null, surface: v.surface ?? 'web', ...(v.at ? { createdAt: v.at } : {}) }));
  }

  /** What the SERVER saw, not what a client claims: first look, and the evidence opened before deciding. */
  async viewsOf(tenantId: string, requestId: string, userId: string): Promise<{ firstViewAt: Date | null; evidenceOpened: boolean; evidenceDwellMs: number | null }> {
    return withTenant(tenantId, async (db) => {
      const rows = await db.select().from(schema.approvalViews).where(and(eq(schema.approvalViews.requestId, requestId), eq(schema.approvalViews.userId, userId)));
      const ev = rows.filter((r) => r.kind === 'evidence');
      const first = rows.reduce<Date | null>((m, r) => (!m || r.createdAt < m ? r.createdAt : m), null);
      return { firstViewAt: first, evidenceOpened: ev.length > 0, evidenceDwellMs: ev.length ? ev.reduce((s, r) => s + (r.dwellMs ?? 0), 0) : null };
    });
  }

  // ------------------------------------------------------------------ the control plane
  /**
   * A person decides (§5.4, §8). Under the row lock: still pending, not expired, the packet they
   * decided on is the one stored (a decision names what it saw), dual approval needs two DISTINCT
   * people and never the requester under separation of duties. The corpus row is written in the
   * same transaction.
   */
  async decide(
    tenantId: string,
    id: string,
    d: { userId: string; role: string; decision: HumanDecision; reason?: string | null; packetDigest: string; editedArgs?: Record<string, unknown> | null; editDiff?: FieldChange[] | null; telemetry: Telemetry; now: Date },
  ): Promise<{ request: RequestRow; decision: DecisionRow; final: boolean }> {
    return withTenant(tenantId, async (db) => {
      const r = await lock(db, id);
      if (!r) throw new ApprovalError('NOT_FOUND', 'approval request not found');
      if (r.state !== 'pending') throw new ApprovalError('NOT_PENDING', `this request is ${r.state}; it can no longer be decided`);
      if (d.now >= r.expiresAt) throw new ApprovalError('EXPIRED', 'this request expired; its fallback applies');
      if (d.packetDigest !== r.packetDigest) throw new ApprovalError('STALE_PACKET', 'what you decided on is not what this request now shows; reload it');
      if (d.decision !== 'reject') {
        if (r.separationOfDuties && d.userId === r.requester) throw new ApprovalError('SEPARATION_OF_DUTIES', 'separation of duties: the person this run acts for cannot approve its action');
        if (r.approvedBy.includes(d.userId)) throw new ApprovalError('DUPLICATE_APPROVER', `you have already approved this; ${r.approvalsRequired} different approvers are required`);
      }
      const edited = d.decision === 'approve_with_edits' && !!d.editDiff?.length;
      const [decision] = await db
        .insert(schema.approvalDecisions)
        .values({
          tenantId,
          requestId: r.id,
          runId: r.runId,
          actionId: r.actionId,
          toolId: r.toolId,
          approverId: d.userId,
          approverRole: d.role,
          decision: d.decision,
          reason: d.reason ?? null,
          edited,
          editDiffJson: edited ? d.editDiff : null,
          latencyMs: d.telemetry.latencyMs,
          evidenceOpened: d.telemetry.evidenceOpened,
          evidenceDwellMs: d.telemetry.evidenceDwellMs,
          surface: d.telemetry.surface,
          packetDigest: r.packetDigest,
          packetChars: d.telemetry.packetChars,
          riskTier: r.riskTier,
        })
        .returning();
      let patch: Partial<typeof schema.approvalRequests.$inferInsert>;
      let final = true;
      if (d.decision === 'reject') patch = { state: 'rejected', resolution: 'decided', resolvedBy: d.userId, resolvedAt: d.now };
      else {
        const approvedBy = [...r.approvedBy, d.userId];
        final = approvedBy.length >= r.approvalsRequired;
        patch = { approvedBy, ...(edited ? { editedArgs: d.editedArgs ?? null, editDiff: d.editDiff ?? null } : {}), ...(final ? { state: 'approved', resolution: 'decided', resolvedBy: d.userId, resolvedAt: d.now } : {}) };
      }
      const [u] = await db.update(schema.approvalRequests).set(patch).where(eq(schema.approvalRequests.id, r.id)).returning();
      return { request: u!, decision: decision!, final };
    });
  }

  /** Ask without deciding (§7): recorded in the corpus, and the expiry pauses — once. */
  async question(tenantId: string, id: string, q: { userId: string; role: string; text: string; telemetry: Telemetry; now: Date }): Promise<RequestRow> {
    return withTenant(tenantId, async (db) => {
      const r = await lock(db, id);
      if (!r) throw new ApprovalError('NOT_FOUND', 'approval request not found');
      if (r.state !== 'pending') throw new ApprovalError('NOT_PENDING', `this request is ${r.state}`);
      if (r.questionAskedAt) throw new ApprovalError('QUESTION_USED', 'a question was already asked on this request; its expiry pauses only once');
      const window = r.expiresAt.getTime() - r.createdAt.getTime();
      await db.insert(schema.approvalDecisions).values({ tenantId, requestId: r.id, runId: r.runId, actionId: r.actionId, toolId: r.toolId, approverId: q.userId, approverRole: q.role, decision: 'question', reason: q.text, latencyMs: q.telemetry.latencyMs, evidenceOpened: q.telemetry.evidenceOpened, evidenceDwellMs: q.telemetry.evidenceDwellMs, surface: q.telemetry.surface, packetDigest: r.packetDigest, packetChars: q.telemetry.packetChars, riskTier: r.riskTier });
      const [u] = await db
        .update(schema.approvalRequests)
        .set({ questionAskedAt: q.now, expiresAt: new Date(r.expiresAt.getTime() + window), ...(r.escalateAt ? { escalateAt: new Date(r.escalateAt.getTime() + window) } : {}) })
        .where(eq(schema.approvalRequests.id, r.id))
        .returning();
      return u!;
    });
  }

  /** The executor re-routes a request whose assignee can no longer decide it. */
  async reassign(tenantId: string, id: string, to: { assignedTo: string | null; delegatedFrom: string | null }): Promise<void> {
    await withTenant(tenantId, (db) => db.update(schema.approvalRequests).set({ assignedTo: to.assignedTo, delegatedFrom: to.delegatedFrom, notifiedAt: null, batchId: null }).where(and(eq(schema.approvalRequests.id, id), eq(schema.approvalRequests.state, 'pending'))));
  }

  // ------------------------------------------------------------------ delegation
  async createDelegation(tenantId: string, d: { fromUser: string; toUser: string; roleScope: string | null; startsAt: Date; endsAt: Date; reason: string | null }) {
    return withTenant(tenantId, async (db) => (await db.insert(schema.delegations).values({ tenantId, ...d }).returning())[0]!);
  }
  async listDelegations(tenantId: string, userId?: string) {
    return withTenant(tenantId, (db) => db.select().from(schema.delegations).where(userId ? sql`${schema.delegations.fromUser} = ${userId} OR ${schema.delegations.toUser} = ${userId}` : undefined).orderBy(desc(schema.delegations.createdAt)));
  }
  async revokeDelegation(tenantId: string, id: string, by: string): Promise<boolean> {
    return withTenant(tenantId, async (db) => (await db.update(schema.delegations).set({ revokedAt: new Date() }).where(and(eq(schema.delegations.id, id), eq(schema.delegations.fromUser, by), isNull(schema.delegations.revokedAt))).returning()).length > 0);
  }

  // ------------------------------------------------------------------ notification budget and batching (§5.3)
  /** Takes one notification from today's budget; false (and counted as overflow) when it is spent. */
  async takeBudget(tenantId: string, userId: string, day: string, budget: number): Promise<{ ok: boolean; sent: number; budget: number }> {
    return withTenant(tenantId, async (db) => {
      await db.insert(schema.notificationBudget).values({ tenantId, userId, day, budget }).onConflictDoNothing();
      const [row] = await db.select().from(schema.notificationBudget).where(and(eq(schema.notificationBudget.userId, userId), eq(schema.notificationBudget.day, day))).for('update');
      if (row!.sent >= row!.budget) {
        await db.update(schema.notificationBudget).set({ overflow: row!.overflow + 1 }).where(and(eq(schema.notificationBudget.userId, userId), eq(schema.notificationBudget.day, day)));
        return { ok: false, sent: row!.sent, budget: row!.budget };
      }
      await db.update(schema.notificationBudget).set({ sent: row!.sent + 1 }).where(and(eq(schema.notificationBudget.userId, userId), eq(schema.notificationBudget.day, day)));
      return { ok: true, sent: row!.sent + 1, budget: row!.budget };
    });
  }

  async budgetOf(tenantId: string, day: string) {
    return withTenant(tenantId, (db) => db.select().from(schema.notificationBudget).where(eq(schema.notificationBudget.day, day)));
  }

  /** The user's accumulating batch for this review moment (created on first use), with the item added. */
  async addToBatch(tenantId: string, requestId: string, userId: string, scheduledAt: Date): Promise<string> {
    return withTenant(tenantId, async (db) => {
      await db.insert(schema.approvalBatches).values({ tenantId, userId, scheduledAt }).onConflictDoNothing();
      const [b] = await db.select().from(schema.approvalBatches).where(and(eq(schema.approvalBatches.userId, userId), eq(schema.approvalBatches.scheduledAt, scheduledAt), eq(schema.approvalBatches.state, 'accumulating'))).for('update');
      await db.update(schema.approvalBatches).set({ itemCount: b!.itemCount + 1 }).where(eq(schema.approvalBatches.id, b!.id));
      await db.update(schema.approvalRequests).set({ batchId: b!.id }).where(eq(schema.approvalRequests.id, requestId));
      return b!.id;
    });
  }

  async batch(tenantId: string, batchId: string) {
    return withTenant(tenantId, async (db) => {
      const [b] = await db.select().from(schema.approvalBatches).where(eq(schema.approvalBatches.id, batchId));
      const items = b ? await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.batchId, batchId), eq(schema.approvalRequests.state, 'pending'))) : [];
      return b ? { ...b, items } : null;
    });
  }

  async currentBatch(tenantId: string, userId: string) {
    return withTenant(tenantId, async (db) => {
      const [b] = await db.select().from(schema.approvalBatches).where(and(eq(schema.approvalBatches.userId, userId), eq(schema.approvalBatches.state, 'accumulating'))).orderBy(schema.approvalBatches.scheduledAt).limit(1);
      return b ?? null;
    });
  }

  async markBatchDelivered(tenantId: string, batchId: string, at: Date): Promise<void> {
    await withTenant(tenantId, async (db) => {
      await db.update(schema.approvalBatches).set({ state: 'delivered', deliveredAt: at }).where(eq(schema.approvalBatches.id, batchId));
      await db.update(schema.approvalRequests).set({ notifiedAt: at }).where(and(eq(schema.approvalRequests.batchId, batchId), isNull(schema.approvalRequests.notifiedAt)));
    });
  }

  /** The push's one-tap reject capability: only its hash is kept. */
  async setRejectToken(tenantId: string, requestId: string, hash: string): Promise<void> {
    await withTenant(tenantId, (db) => db.update(schema.approvalRequests).set({ rejectTokenHash: hash }).where(eq(schema.approvalRequests.id, requestId)));
  }

  /** A batch the budget could not carry waits for the next review moment. */
  async rescheduleBatch(tenantId: string, batchId: string, to: Date): Promise<void> {
    await withTenant(tenantId, (db) => db.update(schema.approvalBatches).set({ scheduledAt: to }).where(eq(schema.approvalBatches.id, batchId)));
  }

  async markNotified(tenantId: string, requestIds: string[], at: Date): Promise<void> {
    if (!requestIds.length) return;
    await withTenant(tenantId, (db) => db.update(schema.approvalRequests).set({ notifiedAt: at }).where(inArray(schema.approvalRequests.id, requestIds)));
  }

  // ------------------------------------------------------------------ rubber-stamp monitoring
  async saveQuality(tenantId: string, q: { approverId: string; windowStart: string; decisions: number; medianLatencyMs: number; p10LatencyMs: number; evidenceOpenRate: number; highEvidenceOpenRate: number | null; editRate: number; rejectRate: number; tooFastRate: number; flag: string | null }): Promise<void> {
    await withTenant(tenantId, (db) =>
      db
        .insert(schema.approvalQuality)
        .values({ tenantId, ...q, computedAt: new Date() })
        .onConflictDoUpdate({ target: [schema.approvalQuality.tenantId, schema.approvalQuality.approverId, schema.approvalQuality.windowStart], set: { ...q, computedAt: new Date() } }),
    );
  }

  async quality(tenantId: string, since: string) {
    return withTenant(tenantId, (db) => db.select().from(schema.approvalQuality).where(gte(schema.approvalQuality.windowStart, since)).orderBy(desc(schema.approvalQuality.windowStart)));
  }
}
