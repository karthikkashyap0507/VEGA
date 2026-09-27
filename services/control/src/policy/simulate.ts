import { combine, evaluatePolicies, PRESET_MODES, presetPolicies, RESTRICTIVENESS, type ChainStep, type Decision, type Policy, type PolicyInput, type PresetMode } from '@vega/policy-engine';
import { scoreRisk, type RiskInput, type Weights } from '@vega/risk';

/**
 * POLICY SIMULATION (docs/module5.md §5.8) — the required gate before activation. Replays the
 * recorded actions of a window against a candidate policy set and reports what would change.
 *
 * Both sides are RECOMPUTED from what was stored — the OPA input document and the risk input
 * with its recorded weights version — using the reference evaluator (proved equivalent to the
 * compiled Rego by the differential suite). So a change in the report is caused by the policy
 * edit alone, not by drift between then and now:
 *
 *   baseline  = preset + the ACTIVE bundle's policies      (what happens today)
 *   candidate = preset + the CANDIDATE bundle's policies   (what would happen)
 *
 * One action is counted once: the latest evaluation of each executed step (a call re-evaluated
 * after an approval or a hold is the same action).
 */

export interface StoredEvaluation {
  id: string;
  runId: string;
  nodeId: string;
  toolId: string;
  preset: string;
  evaluatedAt: Date;
  input: PolicyInput;
  risk: RiskInput;
  weightsVersion: number;
}

export interface Change {
  evaluationId: string;
  runId: string;
  nodeId: string;
  toolId: string;
  evaluatedAt: string;
  from: Decision;
  to: Decision;
  kind: ChangeKind;
  fromChain: ChainStep[];
  toChain: ChainStep[];
}

export type ChangeKind = 'newly_denied' | 'newly_requires_approval' | 'newly_held' | 'newly_automatic' | 'less_restrictive' | 'more_restrictive';

export interface SimulationReport {
  actionsReplayed: number;
  unchanged: number;
  counts: Record<ChangeKind, number>;
  /** Per change kind, the tools it touches most (the "mostly gmail.send to …" line). */
  topTools: Partial<Record<ChangeKind, Array<{ toolId: string; count: number }>>>;
  /** Approvals added minus approvals removed, per week of the window. */
  approvalsPerWeekDelta: number;
  changes: Change[];
  truncated: boolean;
}

const MAX_CHANGES = 500;

function kindOf(from: Decision, to: Decision): ChangeKind {
  const a = RESTRICTIVENESS[from];
  const b = RESTRICTIVENESS[to];
  if (to === 'DENY') return 'newly_denied';
  if ((to === 'REQUIRE_APPROVAL' || to === 'REQUIRE_DUAL_APPROVAL') && a < RESTRICTIVENESS.REQUIRE_APPROVAL) return 'newly_requires_approval';
  if (to === 'ALLOW_WITH_HOLD' && from === 'ALLOW') return 'newly_held';
  if (to === 'ALLOW') return 'newly_automatic';
  return b < a ? 'less_restrictive' : 'more_restrictive';
}

const needsApproval = (d: Decision) => d === 'REQUIRE_APPROVAL' || d === 'REQUIRE_DUAL_APPROVAL';

export function simulate(opts: {
  evaluations: StoredEvaluation[];
  weights: ReadonlyMap<number, Weights>;
  baseline: ReadonlyArray<{ policy: Policy; version: number }>;
  candidate: ReadonlyArray<{ policy: Policy; version: number }>;
  windowDays: number;
}): SimulationReport {
  // The latest evaluation per executed step.
  const latest = new Map<string, StoredEvaluation>();
  for (const e of opts.evaluations) {
    const seen = latest.get(e.nodeId);
    if (!seen || seen.evaluatedAt < e.evaluatedAt) latest.set(e.nodeId, e);
  }
  const presets = new Map<string, Array<{ policy: Policy; version: number }>>();
  const presetOf = (p: string) => {
    const mode = ((PRESET_MODES as readonly string[]).includes(p) ? p : 'balanced') as PresetMode;
    if (!presets.has(mode)) presets.set(mode, presetPolicies(mode));
    return presets.get(mode)!;
  };

  const counts: Record<ChangeKind, number> = { newly_denied: 0, newly_requires_approval: 0, newly_held: 0, newly_automatic: 0, less_restrictive: 0, more_restrictive: 0 };
  const byTool: Partial<Record<ChangeKind, Map<string, number>>> = {};
  const changes: Change[] = [];
  let unchanged = 0;
  let approvalDelta = 0;
  for (const e of [...latest.values()].sort((a, b) => a.evaluatedAt.getTime() - b.evaluatedAt.getTime())) {
    const weights = opts.weights.get(e.weightsVersion);
    if (!weights) throw new Error(`risk weights version ${e.weightsVersion} is missing: stored evaluations cannot be replayed`);
    const risk = scoreRisk(e.risk, weights);
    const preset = presetOf(e.preset);
    const before = combine(risk, evaluatePolicies([...preset, ...opts.baseline], e.input));
    const after = combine(risk, evaluatePolicies([...preset, ...opts.candidate], e.input));
    if (before.decision === after.decision) {
      unchanged++;
      continue;
    }
    const kind = kindOf(before.decision, after.decision);
    counts[kind]++;
    const m = (byTool[kind] ??= new Map());
    m.set(e.toolId, (m.get(e.toolId) ?? 0) + 1);
    approvalDelta += (needsApproval(after.decision) ? 1 : 0) - (needsApproval(before.decision) ? 1 : 0);
    if (changes.length < MAX_CHANGES) {
      changes.push({ evaluationId: e.id, runId: e.runId, nodeId: e.nodeId, toolId: e.toolId, evaluatedAt: e.evaluatedAt.toISOString(), from: before.decision, to: after.decision, kind, fromChain: before.chain, toChain: after.chain });
    }
  }
  const topTools: SimulationReport['topTools'] = {};
  for (const [kind, m] of Object.entries(byTool) as Array<[ChangeKind, Map<string, number>]>) {
    topTools[kind] = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([toolId, count]) => ({ toolId, count }));
  }
  const total = counts.newly_denied + counts.newly_requires_approval + counts.newly_held + counts.newly_automatic + counts.less_restrictive + counts.more_restrictive;
  return {
    actionsReplayed: latest.size,
    unchanged,
    counts,
    topTools,
    approvalsPerWeekDelta: Math.round((approvalDelta / Math.max(1, opts.windowDays / 7)) * 10) / 10,
    changes,
    truncated: total > changes.length,
  };
}
