'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Views of the policy engine (docs/module5.md §7), as the gateway returns them. */

export type Decision = 'ALLOW' | 'ALLOW_WITH_HOLD' | 'REQUIRE_APPROVAL' | 'REQUIRE_DUAL_APPROVAL' | 'DENY';
export type PolicyState = 'draft' | 'simulated' | 'active' | 'retired';
export type Tier = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type PresetMode = 'cautious' | 'balanced' | 'fast';

export interface PolicyRow {
  id: string;
  key: string;
  version: number;
  state: PolicyState;
  description: string;
  citation: string | null;
  severity: 'low' | 'normal' | 'high' | 'critical';
  decision: Decision;
  specYaml: string;
  compiledRego: string;
  activeFrom: string | null;
  activeTo: string | null;
  retiring: boolean;
  createdAt: string;
  activeVersion?: number | null;
}

export interface BundleRow {
  id: string;
  version: number;
  revision: string;
  digest: string;
  policies: Array<{ key: string; version: number }>;
  state: 'candidate' | 'active' | 'superseded';
  createdAt: string;
  activatedAt: string | null;
  supersededAt: string | null;
  simulation: { id: string; createdAt: string; summary: SimulationSummary } | null;
}

export type ChangeKind = 'newly_denied' | 'newly_requires_approval' | 'newly_held' | 'newly_automatic' | 'less_restrictive' | 'more_restrictive';

export interface SimulationSummary {
  bundleVersion: number;
  baselineVersion: number | null;
  windowDays: number;
  actionsReplayed: number;
  unchanged: number;
  counts: Record<ChangeKind, number>;
  topTools: Partial<Record<ChangeKind, Array<{ toolId: string; count: number }>>>;
  approvalsPerWeekDelta: number;
  truncated: boolean;
}

export interface ChainStep {
  step: string;
  detail: string;
  id?: string;
  version?: number;
  citation?: string | null;
}

export interface SimulationChange {
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

export interface Simulation {
  id: string;
  bundleId: string;
  summary: SimulationSummary;
  changes: SimulationChange[];
}

export interface Weights {
  version: number;
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
  w6: number;
  w7: number;
  boundaries: { low: number; medium: number; high: number };
}

export interface RiskFactorLine {
  factor: 'dataSensitivity' | 'blastRadius' | 'externalExposure' | 'irreversibility' | 'authorityGap' | 'taintPressure' | 'certificationCredit';
  value: number;
  weight: number;
  contribution: number;
  text: string;
}

export interface Evaluation {
  id: string;
  nodeId: string;
  dslNodeId: string | null;
  toolId: string;
  decision: Decision;
  approverRole: string | null;
  holdWindowMs: number | null;
  decidedBy: { key: string; version: number };
  bundleVersion: number;
  preset: string;
  failClosed: boolean;
  chain: ChainStep[];
  latencyMs: number | null;
  evaluatedAt: string;
  risk: { score: number; tier: Tier; scoreTier: Tier; weightsVersion: number; hardGates: string[]; factors: Record<string, number>; explanation: RiskFactorLine[] } | null;
}

export const policyKeys = {
  list: ['policies'] as const,
  versions: (key: string) => ['policies', 'versions', key] as const,
  bundles: ['policies', 'bundles'] as const,
  vocabulary: ['policies', 'vocabulary'] as const,
  preset: ['policies', 'preset'] as const,
  simulation: (id: string) => ['policies', 'simulation', id] as const,
  weights: ['risk', 'weights'] as const,
  evaluations: (runId: string) => ['evaluations', runId] as const,
};

export const usePolicies = () =>
  useQuery({ queryKey: policyKeys.list, queryFn: () => api.get<{ items: PolicyRow[]; preset: PresetMode; activeBundle: { id: string; version: number; activatedAt: string } | null }>('/v1/policies') });
export const usePolicyVersions = (key: string | null) =>
  useQuery({ queryKey: policyKeys.versions(key ?? ''), queryFn: () => api.get<{ key: string; versions: PolicyRow[] }>(`/v1/policies/${key}/versions`), enabled: Boolean(key) });
export const useBundles = () => useQuery({ queryKey: policyKeys.bundles, queryFn: () => api.get<BundleRow[]>('/v1/policies/bundles') });
export const useVocabulary = () =>
  useQuery({
    queryKey: policyKeys.vocabulary,
    queryFn: () => api.get<{ fields: Array<{ field: string; type: string; values?: string[]; doc: string }>; tools: string[]; presets: PresetMode[]; packs: string[] }>('/v1/policies/vocabulary'),
    staleTime: 5 * 60_000,
  });
export const usePreset = () => useQuery({ queryKey: policyKeys.preset, queryFn: () => api.get<{ mode: PresetMode; modes: Array<{ mode: PresetMode; yaml: string }> }>('/v1/policies/preset') });
export const useSimulation = (id: string | null) =>
  useQuery({ queryKey: policyKeys.simulation(id ?? ''), queryFn: () => api.get<Simulation>(`/v1/policies/simulations/${id}`), enabled: Boolean(id) });
export const useWeights = () =>
  useQuery({
    queryKey: policyKeys.weights,
    queryFn: () =>
      api.get<{ weights: Weights; tenantOwned: boolean; activeFrom: string; bounds: Record<string, { min: number; max: number }>; history: Array<{ version: number; tenantOwned: boolean; weights: Weights; activeFrom: string }> }>('/v1/risk/weights'),
  });
export const useEvaluations = (runId: string | undefined) =>
  useQuery({ queryKey: policyKeys.evaluations(runId ?? ''), queryFn: () => api.get<Evaluation[]>(`/v1/evaluations?run_id=${runId}`), enabled: Boolean(runId) });

export const DECISION_TEXT: Record<Decision, string> = {
  ALLOW: 'Allowed',
  ALLOW_WITH_HOLD: 'Held, then runs',
  REQUIRE_APPROVAL: 'Needs approval',
  REQUIRE_DUAL_APPROVAL: 'Needs two approvals',
  DENY: 'Denied',
};

export const CHANGE_TEXT: Record<ChangeKind, string> = {
  newly_denied: 'Newly denied',
  newly_requires_approval: 'Newly requiring approval',
  newly_held: 'Newly held',
  newly_automatic: 'Newly automatic',
  less_restrictive: 'Less restrictive',
  more_restrictive: 'More restrictive',
};

export function durationText(ms: number): string {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} h`;
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 1000)} s`;
}
