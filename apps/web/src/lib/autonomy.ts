'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Module 10 views (docs/module10.md §15, §16), as the gateway returns them. */

export type Tier = 'SHADOW' | 'SUPERVISED' | 'SAMPLED' | 'AUTONOMOUS' | 'SUSPENDED';

export const TIER_TEXT: Record<Tier, { label: string; meaning: string }> = {
  SHADOW: { label: 'Shadow', meaning: 'A person reviews every action. Where it starts — nothing is sent without one.' },
  SUPERVISED: { label: 'Supervised', meaning: 'A person approves every action.' },
  SAMPLED: { label: 'Sampled', meaning: 'A person reviews a share of actions; the rest run on their own, within policy.' },
  AUTONOMOUS: { label: 'Autonomous', meaning: 'Runs on its own, within policy. Unusual inputs still go to a person.' },
  SUSPENDED: { label: 'Suspended', meaning: 'Stopped pending investigation. Needs a fresh certification and a person to restore it.' },
};

export interface GateCheck {
  name: string;
  pass: boolean;
  detail: string;
}

export interface LadderRow {
  workflowKey: string;
  agentName: string | null;
  actionType: string;
  tier: Tier;
  sampleRate: number | null;
  daysAtTier: number;
  decisions: number;
  actions: number;
  autonomousRate: number | null;
  edits: number;
  rejections: number;
  errors: number;
  gate: GateCheck[];
  eligible: boolean;
  latestCertification: { id: string; recommendation: string; recommendedTier: string | null; createdAt: string; ratified: boolean } | null;
  openProposals: number;
}

export interface Transition {
  id: string;
  fromTier: Tier;
  toTier: Tier;
  direction: 'PROMOTE' | 'DEMOTE';
  trigger: string;
  evidenceJson: Record<string, unknown>;
  actorId: string | null;
  createdAt: string;
}

export interface CertificationSummary {
  id: string;
  workflowKey: string;
  actionType: string;
  window: { from: string; to: string };
  sampleSize: number;
  agreementRate: number;
  editRate: number;
  criticalErrors: number;
  fromTier: Tier;
  recommendation: 'PROMOTE' | 'HOLD' | 'DEMOTE';
  recommendedTier: Tier | null;
  gate: GateCheck[];
  reportRef: string;
  ratifiedBy: string | null;
  ratifiedAt: string | null;
  createdAt: string;
}

export interface PairDetail {
  state: { tier: Tier; sampleRate: number | null; since: string };
  transitions: Transition[];
  certifications: CertificationSummary[];
  proposals: Proposal[];
}

export interface ErrorClass {
  key: string;
  count: number;
  critical: boolean;
  examples: Array<{ decisionId: string; note: string }>;
}

export interface CertificationReport {
  id: string;
  workflowKey: string;
  actionType: string;
  window: { from: string; to: string };
  fromTier: Tier;
  sampleSize: number;
  agreementRate: number;
  editRate: number;
  criticalErrors: number;
  errorTaxonomy: ErrorClass[];
  pinned: { connectorVersions: Record<string, number>; modelVersions: string[] };
  gate: GateCheck[];
  recommendation: 'PROMOTE' | 'HOLD' | 'DEMOTE';
  recommendedTier: Tier | null;
  signed: { reportRef: string; entryHash: string; note: string };
  ratification: { by: string | null; at: string } | null;
  createdAt: string;
}

export interface Proposal {
  id: string;
  kind: 'promote' | 'demote' | 'new_policy';
  subjectJson: { workflowKey?: string; actionType?: string; change?: string };
  evidenceJson: Record<string, unknown> & { decisionIds?: string[] };
  proposedChange: Record<string, unknown> & { action?: string; note?: string };
  confidence: number;
  state: 'open' | 'accepted' | 'dismissed' | 'expired';
  expiresAt: string;
  createdAt: string;
}

export interface LockRow {
  lockId: string;
  entityKey: string;
  runId: string;
  agentId: string;
  mode: string;
  intent: string;
  acquiredAt: string;
  leaseExpiresAt: string;
}

export interface Activity {
  entityKey: string;
  holders: Array<{ lockId: string; runId: string; agentId: string; mode: string; intent: string; acquiredAt: string; leaseExpiresAt: string }>;
  waiters: Array<{ runId: string; agentId: string; mode: string; riskTier: string | null; waitingSince: string }>;
}

export interface ContactRow {
  id: string;
  externalIdentity: string;
  channel: string;
  contactedAt: string;
  byRunId: string;
  byAgentId: string;
  onBehalfOf: string;
  relationshipType: string | null;
  cooldownUntil: string;
  inCooldown: boolean;
  overrideReason: string | null;
  overriddenBy: string | null;
}

export interface WriteConflict {
  id: string;
  entityKey: string;
  field: string;
  proposals: Array<{ run_id: string; agent_id: string; value: unknown; risk_tier: string | null; at: string }>;
  resolution: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

export interface UsageRow {
  key: string;
  label: string | null;
  runs: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  costCents: number;
  governedActions: number;
  medianDurationMs: number | null;
}
export type UsageBy = 'user' | 'agent' | 'workflow' | 'connector' | 'model';
export interface Usage {
  rows: UsageRow[];
  totals: { runs: number; costCents: number; governedActions: number; costPerGovernedActionCents: number | null };
  notes: string[];
}
export interface Anomaly {
  subjectKind: 'agent' | 'user';
  subjectId: string;
  metric: 'runs' | 'cost_cents';
  today: number;
  baselinePerDay: number;
  factor: number;
}
export interface Budget {
  limitCents: number;
  configuredLimitCents: number;
  breachBehavior: 'degrade' | 'queue' | 'halt';
  spentCents: number;
  remainingCents: number | null;
  percentUsed: number | null;
  projectedCents: number;
  state: 'uncapped' | 'ok' | 'warning' | 'exceeded';
  periodStart: string;
  updatedAt: string | null;
}

export const autonomyKeys = {
  ladder: ['autonomy', 'ladder'] as const,
  pair: (a: string, t: string) => ['autonomy', 'pair', a, t] as const,
  proposals: (s: string) => ['autonomy', 'proposals', s] as const,
  report: (id: string) => ['autonomy', 'report', id] as const,
  locks: ['contention', 'locks'] as const,
  activity: (k: string) => ['contention', 'activity', k] as const,
  ledger: (i: string) => ['contention', 'ledger', i] as const,
  conflicts: ['contention', 'conflicts'] as const,
  usage: (by: string, days: number) => ['usage', by, days] as const,
  anomalies: ['usage', 'anomalies'] as const,
  budget: ['usage', 'budget'] as const,
};

export const useLadder = () => useQuery({ queryKey: autonomyKeys.ladder, queryFn: () => api.get<{ items: LadderRow[] }>('/v1/autonomy') });
export const usePair = (agentId: string, toolId: string, enabled = true) =>
  useQuery({ queryKey: autonomyKeys.pair(agentId, toolId), queryFn: () => api.get<PairDetail>(`/v1/autonomy/${agentId}/${encodeURIComponent(toolId)}`), enabled });
export const useProposals = (state: 'open' | 'accepted' | 'dismissed' = 'open') =>
  useQuery({ queryKey: autonomyKeys.proposals(state), queryFn: () => api.get<{ items: Proposal[] }>(`/v1/autonomy/proposals?state=${state}`) });
export const useReport = (id: string) => useQuery({ queryKey: autonomyKeys.report(id), queryFn: () => api.get<CertificationReport>(`/v1/certifications/${id}/report`) });
export const useLocks = (enabled = true) => useQuery({ queryKey: autonomyKeys.locks, queryFn: () => api.get<{ items: LockRow[] }>('/v1/locks'), enabled, refetchInterval: 15_000 });
export const useActivity = (key: string) =>
  useQuery({ queryKey: autonomyKeys.activity(key), queryFn: () => api.get<Activity>(`/v1/entities/${encodeURIComponent(key)}/activity`), enabled: key.length > 0 });
export const useLedger = (identity: string, enabled: boolean) =>
  useQuery({ queryKey: autonomyKeys.ledger(identity), queryFn: () => api.get<{ items: ContactRow[] }>(`/v1/contact-ledger${identity ? `?identity=${encodeURIComponent(identity)}` : ''}`), enabled });
export const useConflicts = () => useQuery({ queryKey: autonomyKeys.conflicts, queryFn: () => api.get<{ items: WriteConflict[] }>('/v1/write-conflicts') });
export const useUsageBy = (by: UsageBy, days: number, enabled: boolean) => {
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  return useQuery({ queryKey: autonomyKeys.usage(by, days), queryFn: () => api.get<Usage>(`/v1/usage?by=${by}&from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`), enabled });
};
export const useAnomalies = (enabled: boolean) => useQuery({ queryKey: autonomyKeys.anomalies, queryFn: () => api.get<{ items: Anomaly[] }>('/v1/usage/anomalies'), enabled });
export const useBudget = (enabled: boolean) => useQuery({ queryKey: autonomyKeys.budget, queryFn: () => api.get<Budget>('/v1/budgets'), enabled });

export const autonomyActions = {
  enroll: (agentId: string, toolId: string) => api.post<{ created: boolean }>('/v1/autonomy/enroll', { agentId, toolId }),
  certify: (agentId: string, toolId: string, windowDays = 30) => api.post<{ report: { recommendation: string }; certification: CertificationSummary }>('/v1/autonomy/certify', { agentId, toolId, windowDays }),
  promote: (certificationId: string, sampleRate?: number) => api.post<{ transition: Transition }>('/v1/autonomy/promote', { certificationId, ...(sampleRate ? { sampleRate } : {}) }),
  demote: (agentId: string, toolId: string, to: Tier, reason: string) => api.post<Transition>('/v1/autonomy/demote', { agentId, toolId, to, reason }),
  generateProposals: () => api.post<{ created: Proposal[] }>('/v1/autonomy/proposals/generate'),
  decideProposal: (id: string, decision: 'accepted' | 'dismissed') => api.post<{ proposal: Proposal; next: Record<string, unknown> | null }>(`/v1/autonomy/proposals/${id}/decide`, { decision }),
  releaseLock: (id: string, reason: string) => api.post<{ released: boolean }>(`/v1/locks/${id}/release`, { reason }),
  overrideContact: (identity: string, runId: string, reason: string) => api.post('/v1/contact-ledger/override', { identity, runId, reason }),
  resolveConflict: (id: string, chosenRunId: string) => api.post(`/v1/write-conflicts/${id}/resolve`, { chosenRunId }),
  setBudget: (limitCents: number, breachBehavior: Budget['breachBehavior']) => api.put<Budget>('/v1/budgets', { limitCents, breachBehavior }),
  scanAnomalies: () => api.post<{ raised: number }>('/v1/usage/anomalies/scan'),
};

export const pct = (x: number | null | undefined, digits = 0) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);
export const dollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? '—' : `$${(cents / 100).toFixed(2)}`);
export const tierText = (t: Tier, rate: number | null) => `${TIER_TEXT[t].label}${t === 'SAMPLED' && rate ? ` 1:${rate}` : ''}`;

/** Why a certification is not (yet) a promotion, in a sentence — the first failing gate. */
export function gateSummary(row: Pick<LadderRow, 'gate' | 'eligible' | 'latestCertification' | 'tier'>): string {
  if (row.tier === 'SUSPENDED') return 'Suspended: a fresh certification and a person’s ratification restore it.';
  if (row.eligible) return 'Passed certification — waiting for a person to ratify.';
  const failing = row.gate.find((g) => !g.pass);
  if (failing) return `${failing.name}: ${failing.detail}`;
  if (!row.latestCertification) return 'Not certified yet — run a certification when there is history.';
  return row.tier === 'AUTONOMOUS' ? 'At the top of the ladder.' : 'Certified; nothing is waiting.';
}
