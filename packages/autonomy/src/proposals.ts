import { and, eq, gte, lt } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import type { AutonomyStore, ProposalRow } from './store.js';

/**
 * LEARNED POLICY — docs/module10.md §5. Administrators are poor at authoring policy up front;
 * the override corpus (M8) is where the real policy is. This reads it and PROPOSES — a
 * proposal is a read-only artifact that cites the decisions behind it, and nothing here ever
 * applies one (§18: accepting a proposal creates a normal, audited change elsewhere).
 *
 * Rules, all from §5:
 *   · every proposal cites its evidence (decision ids)
 *   · dismissals are training signal — a class dismissed repeatedly stops being generated
 *   · proposals expire; evidence older than the window produces nothing
 *   · edits are grouped by FIELD and STRUCTURAL CHANGE, never by rendered text: three approvers
 *     adding the same disclaimer is one missing policy, not three coincidences
 */
export interface MiningOptions {
  windowDays: number;
  /** Consecutive-approval run needed before suggesting autonomy. */
  promoteMin: number;
  /** Edits of the same structural change before suggesting a policy. */
  editPatternMin: number;
  /** Of the last `recentN` decisions, this many edited → suggest tightening. */
  recentN: number;
  recentEditsMin: number;
  /** Dismissals of one class before it stops being proposed. */
  dismissLimit: number;
  expiresDays: number;
}
export const DEFAULTS: MiningOptions = { windowDays: 90, promoteMin: 30, editPatternMin: 3, recentN: 10, recentEditsMin: 3, dismissLimit: 3, expiresDays: 30 };

interface Decision {
  id: string;
  agentId: string;
  toolId: string;
  decision: string;
  edited: boolean;
  diff: Array<{ path: string; op: string }> | null;
  latencyMs: number;
  approverId: string | null;
  at: Date;
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
/** A structural change, independent of the values involved: `to[0]` and `to[1]` are the same field. */
const shape = (c: { path: string; op: string }) => `${c.path.replace(/\[\d+\]/g, '[]')}:${c.op}`;

export class ProposalMiner {
  constructor(
    private readonly store: AutonomyStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async generate(tenantId: string, opts: Partial<MiningOptions> = {}): Promise<ProposalRow[]> {
    const o = { ...DEFAULTS, ...opts };
    const since = new Date(this.now().getTime() - o.windowDays * 86_400_000);

    const rows = await withTenant(tenantId, async (db) => {
      const decisions = await db
        .select({
          id: schema.approvalDecisions.id,
          agentId: schema.runs.agentId,
          toolId: schema.approvalDecisions.toolId,
          decision: schema.approvalDecisions.decision,
          edited: schema.approvalDecisions.edited,
          diff: schema.approvalDecisions.editDiffJson,
          latencyMs: schema.approvalDecisions.latencyMs,
          approverId: schema.approvalDecisions.approverId,
          at: schema.approvalDecisions.createdAt,
        })
        .from(schema.approvalDecisions)
        .innerJoin(schema.runs, eq(schema.runs.id, schema.approvalDecisions.runId))
        .where(gte(schema.approvalDecisions.createdAt, since));
      const existing = await db.select().from(schema.policyProposals);
      return { decisions: decisions as unknown as Decision[], existing };
    });

    const open = new Set(rows.existing.filter((p) => p.state === 'open').map((p) => keyOf(p.kind, p.subjectJson)));
    const dismissed = new Map<string, number>();
    for (const p of rows.existing.filter((p) => p.state === 'dismissed')) dismissed.set(keyOf(p.kind, p.subjectJson), (dismissed.get(keyOf(p.kind, p.subjectJson)) ?? 0) + 1);
    const allowed = (kind: string, subject: unknown) => !open.has(keyOf(kind, subject)) && (dismissed.get(keyOf(kind, subject)) ?? 0) < o.dismissLimit;

    const byPair = new Map<string, Decision[]>();
    for (const d of rows.decisions) {
      const k = `${d.agentId}|${d.toolId}`;
      byPair.set(k, [...(byPair.get(k) ?? []), d]);
    }

    const created: ProposalRow[] = [];
    const expiresAt = new Date(this.now().getTime() + o.expiresDays * 86_400_000);
    const emit = async (kind: 'promote' | 'demote' | 'new_policy', subject: Record<string, unknown>, evidence: Record<string, unknown>, change: Record<string, unknown>, confidence: number) => {
      if (!allowed(kind, subject)) return;
      created.push(await this.store.createProposal({ tenantId, kind, subjectJson: subject, evidenceJson: evidence, proposedChange: change, confidence, expiresAt }));
    };

    for (const [, ds] of byPair) {
      const sorted = [...ds].sort((a, b) => b.at.getTime() - a.at.getTime());
      const { agentId, toolId } = sorted[0]!;
      const subject = { workflowKey: agentId, actionType: toolId };

      // "You have approved 47 of 47 …" — promote only on an unbroken, edit-free run of approvals.
      const clean = sorted.filter((d) => d.decision === 'approve' && !d.edited);
      if (sorted.length >= o.promoteMin && clean.length === sorted.length) {
        await emit(
          'promote',
          subject,
          { decisions: sorted.length, approved: clean.length, edits: 0, rejections: 0, medianLatencyMs: median(sorted.map((d) => d.latencyMs)), decisionIds: sorted.map((d) => d.id), windowDays: o.windowDays },
          { action: 'request_certification', note: 'ask for a certification run; promotion still needs the gate and your ratification' },
          Math.min(0.99, 0.6 + sorted.length / 200),
        );
      }

      // "3 of the last 10 … were edited before release" — tighten.
      const recent = sorted.slice(0, o.recentN);
      const recentEdits = recent.filter((d) => d.edited);
      if (recent.length >= o.recentN && recentEdits.length >= o.recentEditsMin) {
        await emit(
          'demote',
          subject,
          { recent: recent.length, edits: recentEdits.length, decisionIds: recentEdits.map((d) => d.id), changes: [...new Set(recentEdits.flatMap((d) => (d.diff ?? []).map(shape)))] },
          { action: 'set_tier', tier: 'SUPERVISED' },
          Math.min(0.95, 0.5 + recentEdits.length / 20),
        );
      }

      // Mining the edit diffs: the same structural change, repeated → a missing policy.
      const groups = new Map<string, Decision[]>();
      for (const d of sorted.filter((x) => x.edited && x.diff)) for (const s of new Set((d.diff ?? []).map(shape))) groups.set(s, [...(groups.get(s) ?? []), d]);
      for (const [sh, g] of groups) {
        if (g.length >= o.editPatternMin) {
          await emit(
            'new_policy',
            { ...subject, change: sh },
            { edits: g.length, approvers: new Set(g.map((d) => d.approverId)).size, decisionIds: g.map((d) => d.id) },
            { action: 'author_policy', field: sh.split(':')[0], structuralChange: sh.split(':')[1], note: 'approvers keep making the same change; make it a rule' },
            Math.min(0.95, 0.5 + g.length / 20),
          );
        }
      }
    }
    return created;
  }

  /** Accepting is a decision about the PROPOSAL; the change it describes is made elsewhere, as a normal audited change. */
  async decide(tenantId: string, id: string, decision: 'accepted' | 'dismissed', by: string): Promise<ProposalRow | null> {
    return this.store.decideProposal(tenantId, id, decision, by);
  }

  /** Stale proposals stop being offered (§5 "proposals expire"). */
  async expire(tenantId: string): Promise<number> {
    const now = this.now();
    return withTenant(tenantId, async (db) => (await db.update(schema.policyProposals).set({ state: 'expired' }).where(and(eq(schema.policyProposals.state, 'open'), lt(schema.policyProposals.expiresAt, now))).returning({ id: schema.policyProposals.id })).length);
  }
}

function keyOf(kind: string, subject: unknown): string {
  return `${kind}:${JSON.stringify(subject, Object.keys((subject ?? {}) as object).sort())}`;
}
