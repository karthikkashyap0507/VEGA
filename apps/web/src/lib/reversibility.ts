'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Module 6 views (docs/module6.md §7), as the gateway returns them. */

export type Reversibility = 'R0' | 'R1' | 'R2' | 'R3';

export interface BlastAction {
  nodeId: string;
  toolId: string;
  summary: string;
  reversibility: Reversibility;
  holdSupported: boolean;
  fidelity: string | null;
  externalRecipients: string[];
  recordsAffected: Array<{ system: string; id: string; field?: string; before?: unknown; after?: unknown }>;
  reversibilityNote: string | null;
  monetaryValue: { currency: string; amount: number } | null;
  error: string | null;
}
export interface BlastGroup {
  category: string;
  toolId: string;
  label: string;
  count: number;
  externalDomains: string[];
  externalRecipients: string[];
  reversibility: Reversibility;
  holdSupported: boolean;
  actions: BlastAction[];
}
export interface BlastRadius {
  id: string;
  programVersion: number;
  computedAt: string;
  summary: {
    groups: BlastGroup[];
    consequential: number;
    financial: Array<{ currency: string; amount: number }>;
    reads: Array<{ toolId: string; label: string; calls: number; items: number }>;
    minFidelity: string;
    fidelityNote: string;
    failures: Array<{ nodeId: string; toolId: string; error: string }>;
  };
}

export interface CompensationView {
  id: string;
  actionId: string | null;
  runId: string;
  toolId: string;
  ref: string;
  confidence: 'EXACT' | 'APPROXIMATE';
  sideEffects: 'SILENT' | 'NOTIFIES_THIRD_PARTY';
  description: string;
  state: 'armed' | 'executing' | 'succeeded' | 'failed' | 'expired' | 'not_needed';
  forwardState: 'pending' | 'committed' | 'failed' | 'unknown';
  commitSeq: number | null;
  committedAt: string | null;
  ttlAt: string | null;
  availableFor: string | null;
  undoable: boolean;
  reason: string | null;
  attempts: number;
  rollbackId: string | null;
  executedAt: string | null;
  result: { outcome: string; summary: string; notified: string[]; residual?: string } | null;
  lastError: { code: string; message: string } | null;
}

export interface IncidentView {
  id: string;
  kind: 'compensation_failed' | 'hold_ambiguous' | 'divergence_abort';
  severity: 'HIGH' | 'CRITICAL';
  title: string;
  runId?: string | null;
  state: 'open' | 'acknowledged' | 'resolved';
  detail: { whatFailed?: string | null; error?: { code: string; message: string }; reversed?: Array<{ toolId: string; summary: string }>; notAttempted?: string[]; steps?: string[] } & Record<string, unknown>;
  createdAt: string;
  resolution?: string | null;
}

export interface RunUndo {
  compensations: CompensationView[];
  rollbacks: Array<{ id: string; scope: 'action' | 'run'; trigger: string; state: string; requestedAt: string; finishedAt: string | null; compensationIds: string[] }>;
  incidents: IncidentView[];
}

export interface HoldDetail {
  hold: { id: string; runId: string; actionId: string | null; toolId: string; state: string; expiresAt: string; remainingMs: number; edited: boolean };
  artifact: { toolId: string; args: Record<string, unknown>; effect: { summary: string; externalRecipients: string[] } | null; reason: string };
  editable: string[];
}

export interface UndoStat {
  toolId: string;
  kind: 'revoke' | 'compensate';
  count: number;
  succeeded: number;
  successRate: number;
  medianMs: number | null;
  p99Ms: number | null;
  trend: Array<{ day: string; medianMs: number; count: number }>;
}

export const revKeys = {
  blast: (runId: string) => ['runs', runId, 'blast-radius'] as const,
  undo: (runId: string) => ['runs', runId, 'undo'] as const,
  hold: (id: string) => ['holds', id] as const,
  ttu: (days: number) => ['metrics', 'ttu', days] as const,
  divergences: ['divergences'] as const,
  incidents: (state?: string) => ['incidents', state ?? 'all'] as const,
  push: ['me', 'push-topic'] as const,
};

export const useBlastRadius = (runId: string | undefined) =>
  useQuery({ queryKey: revKeys.blast(runId ?? ''), queryFn: () => api.get<BlastRadius | null>(`/v1/runs/${runId}/blast-radius`), enabled: Boolean(runId) });

export const useRunUndo = (runId: string | undefined, live = false) =>
  useQuery({ queryKey: revKeys.undo(runId ?? ''), queryFn: () => api.get<RunUndo>(`/v1/runs/${runId}/compensations`), enabled: Boolean(runId), refetchInterval: live ? 1_500 : false });

export const useHold = (id: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: revKeys.hold(id ?? ''), queryFn: () => api.get<HoldDetail>(`/v1/holds/${id}`), enabled: Boolean(id) && enabled });

export const useTimeToUndo = (days: number) => useQuery({ queryKey: revKeys.ttu(days), queryFn: () => api.get<{ since: string; items: UndoStat[] }>(`/v1/metrics/time-to-undo?days=${days}`) });

export const useDivergences = () =>
  useQuery({
    queryKey: revKeys.divergences,
    queryFn: () => api.get<{ items: Array<{ id: string; runId: string; toolId: string; severity: string; diff: Array<{ name: string; tolerated: boolean }>; createdAt: string }>; rates: Array<{ toolId: string; actions: number; divergences: number; aborts: number }> }>('/v1/divergences?days=30'),
  });

export const useIncidents = (state?: 'open' | 'acknowledged' | 'resolved') =>
  useQuery({ queryKey: revKeys.incidents(state), queryFn: async () => (await api.get<{ items: IncidentView[] }>(`/v1/incidents${state ? `?state=${state}` : ''}`)).items });

export const usePushTopic = () => useQuery({ queryKey: revKeys.push, queryFn: () => api.get<{ topic: string | null }>('/v1/me/push-topic') });

export const revActions = {
  revoke: (holdId: string) => api.post<{ revoked: boolean; state: string; message: string }>(`/v1/holds/${holdId}/revoke`, {}),
  release: (holdId: string) => api.post<{ released: boolean }>(`/v1/holds/${holdId}/release`, {}),
  edit: (holdId: string, patch: Record<string, string>) => api.post<{ edited: boolean; fields: string[] }>(`/v1/holds/${holdId}/edit-requeue`, { patch }),
  compensate: (actionId: string, confirm: boolean) => api.post<{ rollbackId: string }>(`/v1/actions/${actionId}/compensate`, { confirm }),
  rollbackRun: (runId: string, confirm: boolean) => api.post<{ rollbackId: string }>(`/v1/runs/${runId}/rollback`, { confirm }),
  refreshBlast: (runId: string) => api.post<unknown>(`/v1/runs/${runId}/blast-radius/refresh`, {}),
  acknowledge: (id: string) => api.post<unknown>(`/v1/incidents/${id}/acknowledge`, {}),
  resolve: (id: string, resolution: string) => api.post<unknown>(`/v1/incidents/${id}/resolve`, { resolution }),
};

export function msText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1_000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}
