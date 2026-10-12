'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Module 7 views (docs/module7.md §6, §7), as the gateway returns them. */

export interface ChainEntry {
  tenantId: string;
  seq: number;
  id: string;
  ts: string;
  kind: string;
  source: string;
  payload: Record<string, unknown>;
  payloadDigest: string;
  prevHash: string;
  entryHash: string;
  signature: string;
  keyId: string;
  facets: {
    runId: string | null;
    actionId: string | null;
    actor: string | null;
    agentId: string | null;
    toolId: string | null;
    connectorId: string | null;
    riskTier: string | null;
    decision: string | null;
    outcome: string | null;
    subjects: string[];
  };
}

export interface TreeHead {
  tenantId: string;
  treeSize: number;
  rootHash: string;
  chainHeadSeq: number;
  chainHeadHash: string;
  anchoredAt: string;
  method: string;
  externalRef: string | null;
  keyId: string;
  signature: string;
}

export interface ChainHead {
  head: { seq: number; entryHash: string; ts: string } | null;
  lastAnchor: TreeHead | null;
  entriesSinceAnchor: number;
  verification: {
    ok: boolean;
    checkedAt: string;
    entries: number;
    headSeq: number | null;
    failures: number;
  } | null;
}

export interface Facets {
  from?: string;
  to?: string;
  kinds?: string[];
  runId?: string;
  actionId?: string;
  actor?: string;
  agentId?: string;
  toolId?: string;
  connectorId?: string;
  riskTier?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  decision?: string;
  subject?: string;
}

export interface PackStatus {
  id: string;
  status: 'building' | 'built' | 'failed' | 'interrupted';
  query: Facets;
  requestedBy: string;
  requestedAt: string;
  includeBodies: boolean;
  entryCount: number | null;
  sizeBytes: number | null;
  digest: string | null;
  durationMs: number | null;
  error: string | null;
  builtAt: string | null;
  expiresAt: string | null;
  progress: { stage: string; entries: number } | null;
  downloadUrl?: string | null;
}

export interface ReplayLayer {
  layer: 'interpreter' | 'risk' | 'policy' | 'model';
  status: 'match' | 'diverged' | 'inconclusive';
  deterministic: boolean;
  original: unknown;
  replayed: unknown;
  detail: string;
}

export interface ReplayResult {
  id: string;
  actionId: string;
  entrySeq: number;
  matched: boolean;
  conclusive?: boolean;
  layers: ReplayLayer[];
  originalDigest: string;
  replayDigest: string;
  toolCallsAttempted?: number;
  createdAt: string;
}

export interface RunTrace {
  runId: string;
  entryCount: number;
  integrity: { ok: boolean; checked: number; failures: number[] };
  window: { from: string | null; to: string | null };
  what: Array<{
    actionId: string;
    tool: string;
    outcome: string;
    summary: string | null;
    at: string;
    seq: number;
  }>;
  why: {
    objective: string | null;
    programs: Array<{
      version: number;
      digest: string | null;
      model: string | null;
      promptVersion: string | null;
      at: string;
      seq: number;
    }>;
    steps: Array<{
      actionId: string;
      tool: string;
      reason: string | null;
      decision: string | null;
      seq: number;
    }>;
  };
  tools: Array<{
    actionId: string;
    callSeq: number;
    tool: string;
    egress: string;
    reversibility: string;
    connectorId: string | null;
    argumentsDigest: string;
    arguments: unknown;
    argTaint: string;
    outcome: string | null;
    effectDigest: string | null;
    effect: unknown;
    error: string | null;
    at: string;
    seq: number;
  }>;
  influences: Array<{ source: string; taint: string; actions: string[] }>;
  policies: Array<{
    actionId: string;
    tool: string;
    decision: string | null;
    decidedBy: string | null;
    reason: string | null;
    failClosed: boolean;
    evaluated: Array<{
      id: string;
      version: number | null;
      decision: string;
      citation: string | null;
    }>;
    risk: { score: number | null; tier: string | null; weightsVersion: number | null } | null;
    bundleVersion: number | null;
    seq: number;
  }>;
  approvals: Array<{
    actionId: string;
    tool: string;
    required: boolean;
    granted: boolean;
    approverRole: string | null;
    by: string[];
    evidenceDigest: string | null;
    hold: { window_ms: number; released: boolean; revoked: boolean } | null;
    seq: number;
  }>;
  compensations: Array<{
    kind: string;
    tool: string | null;
    summary: string | null;
    at: string;
    seq: number;
  }>;
  timeline: Array<{
    seq: number;
    ts: string;
    kind: string;
    actionId: string | null;
    tool: string | null;
    summary: string;
  }>;
}

/** Facets → query string (arrays as CSV, empties dropped). */
export function facetQuery(f: Facets & { cursor?: number; limit?: number }): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const evidenceKeys = {
  head: () => ['evidence', 'head'] as const,
  entries: (f: Facets) => ['evidence', 'entries', f] as const,
  count: (f: Facets) => ['evidence', 'count', f] as const,
  packs: () => ['evidence', 'packs'] as const,
  pack: (id: string) => ['evidence', 'packs', id] as const,
  trace: (runId: string) => ['evidence', 'trace', runId] as const,
  replays: (actionId: string) => ['evidence', 'replays', actionId] as const,
};

export function useChainHead(enabled = true) {
  return useQuery({
    queryKey: evidenceKeys.head(),
    queryFn: () => api.get<ChainHead>('/v1/audit/head'),
    enabled,
    refetchInterval: 30_000,
  });
}

export function useEntryCount(f: Facets, enabled = true) {
  return useQuery({
    queryKey: evidenceKeys.count(f),
    queryFn: () => api.get<{ count: number }>(`/v1/audit/entries/count${facetQuery(f)}`),
    enabled,
  });
}

export function usePacks(enabled = true) {
  return useQuery({
    queryKey: evidenceKeys.packs(),
    queryFn: () => api.get<{ items: PackStatus[] }>('/v1/evidence-packs?limit=20'),
    enabled,
    // While anything builds, poll: the progress bar is the point of the page.
    refetchInterval: (q) =>
      q.state.data?.items.some((p) => p.status === 'building') ? 1_000 : false,
  });
}

export function useTrace(runId: string) {
  return useQuery({
    queryKey: evidenceKeys.trace(runId),
    queryFn: () => api.get<RunTrace>(`/v1/runs/${runId}/trace`),
  });
}

export function useReplays(actionId: string, enabled = true) {
  return useQuery({
    queryKey: evidenceKeys.replays(actionId),
    queryFn: () =>
      api.get<{ items: Array<ReplayResult & { layers: ReplayLayer[] }> }>(
        `/v1/actions/${encodeURIComponent(actionId)}/replays`,
      ),
    enabled,
  });
}

export const evidenceActions = {
  verify: () =>
    api.post<{
      ok: boolean;
      entries: number;
      failures: Array<{ check: string; seq?: number; detail: string }>;
    }>('/v1/audit/verify', { full: true }),
  anchor: () => api.post<TreeHead>('/v1/audit/anchors'),
  buildPack: (body: { query?: Facets; template?: string; includeBodies?: boolean }) =>
    api.post<{ id: string; status: string }>('/v1/evidence-packs', body),
  replay: (actionId: string) =>
    api.post<ReplayResult>(`/v1/replay/${encodeURIComponent(actionId)}`),
  content: (digest: string) =>
    api.get<{
      digest: string;
      mediaType: string;
      size: number;
      text: string | null;
      base64: string | null;
    }>(`/v1/audit/content/${digest}`),
};

export const KIND_LABEL: Record<string, string> = {
  'action.pre': 'Action — before',
  'action.post': 'Action — outcome',
  'run.program': 'Plan',
  'policy.activated': 'Policy activated',
  'compensation.succeeded': 'Undone',
  'compensation.failed': 'Undo failed',
  redaction: 'Redaction',
  'evidence.pack_built': 'Evidence pack built',
  'replay.recorded': 'Replay',
  approval: 'Approval',
  hold: 'Hold',
  admin: 'Admin',
  'taint.violation': 'Taint violation',
  'autonomy.changed': 'Autonomy changed',
};

export const shortDigest = (d: string | null | undefined) =>
  d ? `${d.slice(0, 15)}…${d.slice(-6)}` : '—';
export const bytesText = (n: number | null) =>
  n === null
    ? '—'
    : n < 1024
      ? `${n} B`
      : n < 1_048_576
        ? `${(n / 1024).toFixed(1)} KB`
        : `${(n / 1_048_576).toFixed(1)} MB`;
