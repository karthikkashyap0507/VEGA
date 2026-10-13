import { and, desc, eq } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import type { Tier } from './ladder.js';

export type AutonomyStateRow = typeof schema.autonomyState.$inferSelect;
export type CertificationRow = typeof schema.certifications.$inferSelect;
export type TransitionRow = typeof schema.autonomyTransitions.$inferSelect;
export type ProposalRow = typeof schema.policyProposals.$inferSelect;

export interface TransitionInput {
  tenantId: string;
  workflowKey: string;
  actionType: string;
  fromTier: Tier;
  toTier: Tier;
  direction: 'PROMOTE' | 'DEMOTE';
  trigger: 'certification' | 'critical_error' | 'error_rate' | 'comp_failure' | 'taint_violation' | 'novelty' | 'version_change' | 'volume_spike' | 'manual';
  evidence: Record<string, unknown>;
  actorId?: string | null;
  /** PROMOTE only: who ratified it, and the certification it rests on. */
  certificationId?: string | null;
  sampleRate?: number | null;
}

/** One row per (tenant, workflow, action) — the ladder's current state (§3). */
export class AutonomyStore {
  async get(tenantId: string, workflowKey: string, actionType: string): Promise<AutonomyStateRow | null> {
    return withTenant(tenantId, async (db) => (await db.select().from(schema.autonomyState).where(and(eq(schema.autonomyState.workflowKey, workflowKey), eq(schema.autonomyState.actionType, actionType))))[0] ?? null);
  }

  async list(tenantId: string, workflowKey?: string): Promise<AutonomyStateRow[]> {
    return withTenant(tenantId, (db) => db.select().from(schema.autonomyState).where(workflowKey ? eq(schema.autonomyState.workflowKey, workflowKey) : undefined).orderBy(schema.autonomyState.workflowKey, schema.autonomyState.actionType));
  }

  /**
   * A transition is always THE RECORD (§18 "demotion cannot be suppressed"): this writes the
   * autonomy_transitions row and the new autonomy_state in one place, so there is no path from
   * one to the other missing the audit trail.
   */
  async transition(i: TransitionInput): Promise<{ state: AutonomyStateRow; transition: TransitionRow }> {
    return withTenant(i.tenantId, async (db) => {
      const [transition] = await db
        .insert(schema.autonomyTransitions)
        .values({ tenantId: i.tenantId, workflowKey: i.workflowKey, actionType: i.actionType, fromTier: i.fromTier, toTier: i.toTier, direction: i.direction, trigger: i.trigger, evidenceJson: i.evidence, actorId: i.actorId ?? null })
        .returning();
      const [state] = await db
        .insert(schema.autonomyState)
        .values({
          tenantId: i.tenantId,
          workflowKey: i.workflowKey,
          actionType: i.actionType,
          tier: i.toTier,
          sampleRate: i.sampleRate ?? null,
          certificationId: i.certificationId ?? null,
          ratifiedBy: i.direction === 'PROMOTE' ? (i.actorId ?? null) : null,
          since: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.autonomyState.tenantId, schema.autonomyState.workflowKey, schema.autonomyState.actionType],
          set: { tier: i.toTier, sampleRate: i.sampleRate ?? null, certificationId: i.certificationId ?? null, ratifiedBy: i.direction === 'PROMOTE' ? (i.actorId ?? null) : null, since: new Date() },
        })
        .returning();
      // The tenant's own event stream (webhooks, the run timeline): promotion and demotion are news.
      await db.insert(schema.platformEvents).values({
        tenantId: i.tenantId,
        actorId: i.actorId ?? null,
        kind: i.direction === 'PROMOTE' ? 'autonomy.promoted' : 'autonomy.demoted',
        payload: { workflowKey: i.workflowKey, actionType: i.actionType, from: i.fromTier, to: i.toTier, trigger: i.trigger, transitionId: transition!.id, evidence: i.evidence },
      });
      return { state: state!, transition: transition! };
    });
  }

  async transitions(tenantId: string, workflowKey?: string, actionType?: string): Promise<TransitionRow[]> {
    return withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.autonomyTransitions)
        .where(and(workflowKey ? eq(schema.autonomyTransitions.workflowKey, workflowKey) : undefined, actionType ? eq(schema.autonomyTransitions.actionType, actionType) : undefined))
        .orderBy(desc(schema.autonomyTransitions.createdAt)),
    );
  }

  async saveCertification(row: typeof schema.certifications.$inferInsert): Promise<CertificationRow> {
    return withTenant(row.tenantId, async (db) => {
      const [c] = await db.insert(schema.certifications).values(row).returning();
      await db.insert(schema.platformEvents).values({ tenantId: row.tenantId, actorId: null, kind: 'certification.completed', payload: { certificationId: c!.id, workflowKey: row.workflowKey, actionType: row.actionType, recommendation: row.recommendation, sampleSize: row.sampleSize, agreementRate: row.agreementRate } });
      return c!;
    });
  }

  async certification(tenantId: string, id: string): Promise<CertificationRow | null> {
    return withTenant(tenantId, async (db) => (await db.select().from(schema.certifications).where(eq(schema.certifications.id, id)))[0] ?? null);
  }

  async ratify(tenantId: string, certificationId: string, by: string): Promise<CertificationRow> {
    return withTenant(tenantId, async (db) => (await db.update(schema.certifications).set({ decidedBy: by, decidedAt: new Date() }).where(eq(schema.certifications.id, certificationId)).returning())[0]!);
  }

  async proposals(tenantId: string, state: 'open' | 'accepted' | 'dismissed' | 'expired' = 'open'): Promise<ProposalRow[]> {
    return withTenant(tenantId, (db) => db.select().from(schema.policyProposals).where(eq(schema.policyProposals.state, state)).orderBy(desc(schema.policyProposals.createdAt)));
  }

  async createProposal(row: typeof schema.policyProposals.$inferInsert): Promise<ProposalRow> {
    return withTenant(row.tenantId, async (db) => {
      const [p] = await db.insert(schema.policyProposals).values(row).returning();
      await db.insert(schema.platformEvents).values({ tenantId: row.tenantId, actorId: null, kind: 'proposal.created', payload: { proposalId: p!.id, kind: row.kind, subject: row.subjectJson, confidence: row.confidence } });
      return p!;
    });
  }

  async decideProposal(tenantId: string, id: string, decision: 'accepted' | 'dismissed', by: string): Promise<ProposalRow | null> {
    return withTenant(tenantId, async (db) => (await db.update(schema.policyProposals).set({ state: decision, decidedBy: by, decidedAt: new Date() }).where(and(eq(schema.policyProposals.id, id), eq(schema.policyProposals.state, 'open'))).returning())[0] ?? null);
  }

  async saveNoveltyBaseline(row: typeof schema.noveltyBaselines.$inferInsert): Promise<void> {
    await withTenant(row.tenantId, (db) => db.insert(schema.noveltyBaselines).values(row));
  }

  async latestBaseline(tenantId: string, workflowKey: string, actionType: string) {
    return withTenant(tenantId, async (db) =>
      (await db.select().from(schema.noveltyBaselines).where(and(eq(schema.noveltyBaselines.workflowKey, workflowKey), eq(schema.noveltyBaselines.actionType, actionType))).orderBy(desc(schema.noveltyBaselines.computedAt)).limit(1))[0] ?? null,
    );
  }
}
