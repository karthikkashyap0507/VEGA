import { and, between, eq, inArray, sql } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import { capture, featuresOf, type FeatureStats } from './novelty.js';
import type { Tier } from './ladder.js';
import type { AutonomyStore, CertificationRow } from './store.js';

/**
 * CERTIFICATION BY REPLAY — docs/module10.md §4. A workflow is promoted by evidence, not
 * opinion: every sampled decision in the window is read back from the override corpus (M8),
 * scored, classified, and the result is signed into the evidence chain (M7) before anything
 * can be ratified.
 *
 * Scoring is plain arithmetic a risk committee can recompute (§17): agreement = approved
 * unedited / decisions; edit rate = edited / decisions; critical errors are counted, never
 * averaged away ("zero, ever").
 */

export interface Thresholds {
  minSample: number;
  /** R2/R3 actions need more history before they can be trusted (§4.1). */
  minSampleIrreversible: number;
  agreement: number;
  editRate: number;
}
export const DEFAULT_THRESHOLDS: Thresholds = { minSample: 200, minSampleIrreversible: 400, agreement: 0.95, editRate: 0.25 };

export interface ToolFacts {
  toolId: string;
  version: number;
  reversibility: string;
  simulateFidelity: string;
  recipientArgs: string[];
  /** An MCP tool nobody has declared stops at SUPERVISED (M2 §autonomyCap). */
  autonomyCap?: 'SUPERVISED' | null;
}

export interface CertifyInput {
  tenantId: string;
  workflowKey: string;
  actionType: string;
  windowFrom: Date;
  windowTo: Date;
  /** Injected: tool declarations live behind the execution plane's API, not this database. */
  tool: ToolFacts;
  thresholds?: Partial<Thresholds>;
  /** The evidence plane's signing: append the report, return what the certification row stores. */
  sign: (report: CertificationReport) => Promise<{ reportRef: string; signature: string }>;
}

export interface ErrorClass {
  key: string;
  count: number;
  critical: boolean;
  examples: Array<{ decisionId: string; note: string }>;
}

export interface GateCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface CertificationReport {
  workflowKey: string;
  actionType: string;
  window: { from: string; to: string };
  fromTier: Tier | null;
  sampleSize: number;
  agreementRate: number;
  editRate: number;
  criticalErrors: number;
  errorTaxonomy: ErrorClass[];
  pinned: { connectorVersions: Record<string, number>; modelVersions: string[] };
  gate: GateCheck[];
  recommendation: 'PROMOTE' | 'HOLD' | 'DEMOTE';
  recommendedTier: Tier | null;
  thresholds: Thresholds;
}

const NEXT_TIER: Record<Tier, Tier | null> = { SHADOW: 'SUPERVISED', SUPERVISED: 'SAMPLED', SAMPLED: 'AUTONOMOUS', AUTONOMOUS: null, SUSPENDED: null };

/** An edit that touched a recipient is the one error class §4's own example calls CRITICAL. */
function touchesRecipient(diff: unknown, recipientArgs: string[]): boolean {
  if (!Array.isArray(diff)) return false;
  const roots = recipientArgs.map((p) => p.replace(/\[\]$/, '').split('.')[0]!);
  return diff.some((c) => typeof (c as { path?: unknown }).path === 'string' && roots.some((r) => ((c as { path: string }).path).startsWith(r)));
}

const REASON_CLASSES: Array<[RegExp, string]> = [
  [/tone|polite|rude|formal|wording/i, 'tone_mismatch'],
  [/context|missing|forgot|lack/i, 'missing_context'],
  [/claim|number|price|figure|unsupported|wrong amount/i, 'unsupported_claim'],
  [/recipient|wrong person|cc|bcc/i, 'wrong_recipient'],
];

export class CertificationEngine {
  constructor(private readonly store: AutonomyStore) {}

  async certify(i: CertifyInput): Promise<{ report: CertificationReport; row: CertificationRow; baseline: FeatureStats }> {
    const th: Thresholds = { ...DEFAULT_THRESHOLDS, ...i.thresholds };
    const current = await this.store.get(i.tenantId, i.workflowKey, i.actionType);
    const fromTier = (current?.tier as Tier | undefined) ?? 'SHADOW';

    const data = await withTenant(i.tenantId, async (db) => {
      const decisions = await db
        .select({
          id: schema.approvalDecisions.id,
          runId: schema.approvalDecisions.runId,
          decision: schema.approvalDecisions.decision,
          edited: schema.approvalDecisions.edited,
          diff: schema.approvalDecisions.editDiffJson,
          reason: schema.approvalDecisions.reason,
          at: schema.approvalDecisions.createdAt,
          packet: schema.approvalRequests.packetJson,
        })
        .from(schema.approvalDecisions)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.approvalDecisions.runId))
        .innerJoin(schema.approvalRequests, eq(schema.approvalRequests.id, schema.approvalDecisions.requestId))
        .where(and(eq(schema.approvalDecisions.toolId, i.actionType), eq(schema.runs.agentId, i.workflowKey), between(schema.approvalDecisions.createdAt, i.windowFrom, i.windowTo)));
      const runIds = [...new Set(decisions.map((d) => d.runId))];
      const violations = runIds.length ? await db.select({ runId: schema.taintViolations.runId, kind: schema.taintViolations.kind }).from(schema.taintViolations).where(and(eq(schema.taintViolations.toolId, i.actionType), inArray(schema.taintViolations.runId, runIds.map(String)))) : [];
      const failedComp = runIds.length ? await db.select({ runId: schema.compensations.runId }).from(schema.compensations).where(and(eq(schema.compensations.toolId, i.actionType), eq(schema.compensations.state, 'failed'), inArray(schema.compensations.runId, runIds))) : [];
      const ver = await db
        .select({ runId: schema.verifications.runId, outcome: schema.verifications.outcome, failed: schema.verifications.failedCheck })
        .from(schema.verifications)
        .where(and(eq(schema.verifications.agentId, i.workflowKey), eq(schema.verifications.toolId, i.actionType), between(schema.verifications.createdAt, i.windowFrom, i.windowTo), sql`${schema.verifications.outcome} IN ('ABORT','COMPENSATE')`));
      const models = runIds.length
        ? await db.selectDistinct({ modelId: schema.programs.modelId }).from(schema.programs).where(inArray(schema.programs.runId, runIds.map(String)))
        : [];
      return { decisions, violations, failedComp, ver, models };
    });

    const n = data.decisions.length;
    const approvedClean = data.decisions.filter((d) => d.decision === 'approve' && !d.edited).length;
    const edited = data.decisions.filter((d) => d.edited);
    const rejected = data.decisions.filter((d) => d.decision === 'reject');

    // ---- error taxonomy: classify every disagreement; critical classes are counted separately ----
    const classes = new Map<string, ErrorClass>();
    const bump = (key: string, critical: boolean, id: string, note: string) => {
      const c = classes.get(key) ?? { key, count: 0, critical, examples: [] };
      c.count++;
      c.critical ||= critical;
      if (c.examples.length < 3) c.examples.push({ decisionId: id, note });
      classes.set(key, c);
    };
    for (const d of edited) {
      if (touchesRecipient(d.diff, i.tool.recipientArgs)) bump('wrong_recipient', true, d.id, 'the approver changed who receives it');
      else bump('content_edit', false, d.id, Array.isArray(d.diff) ? `${(d.diff as unknown[]).length} field(s) edited` : 'edited before release');
    }
    for (const d of rejected) {
      const hit = REASON_CLASSES.find(([re]) => re.test(d.reason ?? ''));
      const key = hit?.[1] ?? 'rejected_other';
      bump(key, key === 'wrong_recipient', d.id, (d.reason ?? 'rejected without a reason').slice(0, 120));
    }
    for (const v of data.violations) bump('taint_violation', true, v.runId, `${v.kind} violation on ${i.actionType}`);
    for (const c of data.failedComp) bump('compensation_failed', true, c.runId, 'an undo of this action failed');
    // A pre-commit ABORT is the system catching a problem before harm — an error to count, not a
    // critical one. A post-commit failure means it already happened: critical, zero tolerance.
    for (const v of data.ver) bump(v.outcome === 'COMPENSATE' ? 'post_commit_verification_failure' : 'verification_abort', v.outcome === 'COMPENSATE', v.runId, `verification ${v.outcome}${v.failed ? ` at ${v.failed}` : ''}`);

    const errorTaxonomy = [...classes.values()].sort((a, b) => b.count - a.count);
    const criticalErrors = errorTaxonomy.filter((c) => c.critical).reduce((s, c) => s + c.count, 0);
    const agreementRate = n ? approvedClean / n : 0;
    const editRate = n ? edited.length / n : 0;

    // ---- pinned versions (§4 step 4): a change after this point invalidates the certification ----
    const connectorVersions = { [i.tool.toolId]: i.tool.version };
    const modelVersions = data.models.map((m) => m.modelId).sort();
    const prev = (await withTenant(i.tenantId, (db) => db.select().from(schema.certifications).where(and(eq(schema.certifications.workflowKey, i.workflowKey), eq(schema.certifications.actionType, i.actionType))).orderBy(sql`${schema.certifications.createdAt} DESC`).limit(1)))[0];
    const prevConnector = (prev?.connectorVersions as Record<string, number> | undefined)?.[i.tool.toolId];
    const connectorUnchanged = prevConnector === undefined || prevConnector === i.tool.version;
    const prevModels = (prev?.modelVersions as string[] | undefined) ?? [];
    const modelsUnchanged = !prev || modelVersionsCover(prevModels, modelVersions);

    const irreversible = i.tool.reversibility === 'R2' || i.tool.reversibility === 'R3';
    const need = irreversible ? th.minSampleIrreversible : th.minSample;
    const gate: GateCheck[] = [
      { name: 'sample size', pass: n >= need, detail: `${n} decisions (need ${need}${irreversible ? `, ${i.tool.reversibility} action` : ''})` },
      { name: 'agreement', pass: agreementRate >= th.agreement, detail: `${(agreementRate * 100).toFixed(1)}% (threshold ${(th.agreement * 100).toFixed(0)}%)` },
      { name: 'edit rate', pass: editRate <= th.editRate, detail: `${(editRate * 100).toFixed(1)}% (threshold ≤ ${(th.editRate * 100).toFixed(0)}%)` },
      { name: 'critical errors', pass: criticalErrors === 0, detail: `${criticalErrors} (threshold 0, ever)` },
      { name: 'connector version unchanged', pass: connectorUnchanged, detail: `${i.tool.toolId} v${i.tool.version}${prevConnector !== undefined ? ` (was v${prevConnector})` : ''}` },
      { name: 'model versions unchanged', pass: modelsUnchanged, detail: modelVersions.length ? modelVersions.join(', ') : 'none recorded' },
      { name: 'simulation fidelity is not DECLARED', pass: i.tool.simulateFidelity !== 'DECLARED', detail: i.tool.simulateFidelity },
    ];

    const next = NEXT_TIER[fromTier];
    const capBlocks = i.tool.autonomyCap === 'SUPERVISED' && next !== null && next !== 'SUPERVISED';
    gate.push({ name: 'tool autonomy cap permits the next tier', pass: !capBlocks, detail: i.tool.autonomyCap ? `${i.tool.toolId} is capped at ${i.tool.autonomyCap} until its declaration is reviewed` : 'no cap' });
    const allPass = gate.every((g) => g.pass);
    // DEMOTE = the history itself shows harm (a critical error, or agreement badly short);
    // HOLD = not enough evidence yet, or a soft threshold missed; PROMOTE = everything holds.
    const recommendation: CertificationReport['recommendation'] = criticalErrors > 0 || (n >= 20 && agreementRate < 0.5) ? 'DEMOTE' : allPass && next ? 'PROMOTE' : 'HOLD';

    const report: CertificationReport = {
      workflowKey: i.workflowKey,
      actionType: i.actionType,
      window: { from: i.windowFrom.toISOString(), to: i.windowTo.toISOString() },
      fromTier: current ? fromTier : null,
      sampleSize: n,
      agreementRate,
      editRate,
      criticalErrors,
      errorTaxonomy,
      pinned: { connectorVersions, modelVersions },
      gate,
      recommendation,
      recommendedTier: recommendation === 'PROMOTE' ? next : null,
      thresholds: th,
    };

    // §6.1: capture the input distribution of what was certified, so runtime can tell what is new.
    const baseline = capture(
      data.decisions.map((d) => {
        const p = d.packet as { what?: { effects?: Array<{ kind: string; value: string }> }; evidence?: { content?: Record<string, unknown> } } | null;
        const recipients = (p?.what?.effects ?? []).filter((e) => e.kind === 'recipient').map((e) => e.value);
        const text = Object.values(p?.evidence?.content ?? {}).filter((v): v is string => typeof v === 'string').join('');
        return featuresOf({ at: d.at, recipients, textLength: text.length });
      }),
    );

    const { reportRef, signature } = await i.sign(report);
    const row = await this.store.saveCertification({
      tenantId: i.tenantId,
      workflowKey: i.workflowKey,
      actionType: i.actionType,
      windowFrom: i.windowFrom,
      windowTo: i.windowTo,
      sampleSize: n,
      agreementRate,
      editRate,
      criticalErrors,
      errorTaxonomy,
      connectorVersions,
      modelVersions,
      fromTier,
      recommendation,
      recommendedTier: report.recommendedTier,
      gateJson: gate,
      reportRef,
      signature,
    });
    return { report, row, baseline };
  }
}

/** Every model the certification saw must still be one the new window uses (a NEW model invalidates). */
function modelVersionsCover(previous: string[], now: string[]): boolean {
  const prev = new Set(previous);
  return now.every((m) => prev.has(m));
}
