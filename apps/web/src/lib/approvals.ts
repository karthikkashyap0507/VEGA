'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Module 8 views (docs/module8.md §5.1, §6, §7), as the gateway returns them. */

export interface DecisionPacket {
  packet_version: number;
  title: string;
  what: { summary: string; effects: Array<{ kind: 'recipient' | 'record'; value: string }>; reversibility: string; reversibility_text: string; egress: string; hold_window_ms: number | null; fidelity: string | null };
  why: { objective: string; trigger: string; reasoning: string };
  evidence: { sources: Array<{ id: string; taint: string; fields: string[] }>; untrusted_fields: string[]; unsupported_claims: Array<{ text: string; reason: string }>; provenance_ref: string; content: Record<string, unknown> };
  risk: { score: number | null; tier: string | null; factors: Record<string, number> };
  policy: { decision: string; id: string | null; citation: string | null; reason: string | null; reason_chain: Array<{ step: string; detail: string }> };
  routing: { approver_role: string; approvals_required: number; separation_of_duties: boolean };
  recommended: 'approve' | 'reject';
  /** Module 9 (present only when verification ran): the pre-commit checks, in order. */
  verification?: { outcome: string; checks: Array<{ check: string; outcome: string; detail: string }> };
  if_you_do_nothing: { at: string; fallback: string; outcome: string };
  actions: string[];
}

export interface PacketView {
  id: string;
  state: string;
  packet: DecisionPacket;
  digest: string;
  expiresAt: string;
  approvalsRequired: number;
  approvals: number;
}

export interface QueueItem {
  id: string;
  runId: string;
  toolId: string;
  title: string;
  riskTier: string | null;
  urgency: 'normal' | 'urgent';
  egress: string;
  reversibility: string;
  approverRole: string;
  approvalsRequired: number;
  approvals: number;
  assignedToMe: boolean;
  onBehalfOf: string | null;
  delegatedFrom: string | null;
  requester: string;
  requesterName: string | null;
  expiresAt: string;
  createdAt: string;
  escalationLevel: number;
  questionAskedAt: string | null;
  fallback: string;
  group: string;
}

export const approvalKeys = {
  queue: (f: object = {}) => ['approvals', 'queue', f] as const,
  brief: () => ['action-center', 'brief'] as const,
};

export function useQueue(filter: { tier?: string } = {}) {
  const qs = filter.tier ? `?tier=${filter.tier}` : '';
  return useQuery({ queryKey: approvalKeys.queue(filter), queryFn: () => api.get<{ items: QueueItem[]; groups: Array<{ key: string; count: number }> }>(`/v1/approvals${qs}`), refetchInterval: 15_000 });
}

export const approvalActions = {
  /** Fetching the packet is the server's record that you looked (latency starts here). */
  packet: (id: string, surface: 'web' | 'mobile' = 'web') => api.get<PacketView>(`/v1/approvals/${id}/packet?surface=${surface}`),
  evidence: (id: string, dwellMs: number | null, surface: 'web' | 'mobile' = 'web') => api.post<{ recorded: boolean }>(`/v1/approvals/${id}/evidence`, { dwellMs, surface }),
  decide: (id: string, body: { decision: 'approve' | 'approve_with_edits' | 'reject'; packetDigest: string; reason?: string; edits?: Record<string, unknown>; surface?: 'web' | 'mobile' }) => api.post<{ request: { state: string }; final: boolean }>(`/v1/approvals/${id}/decide`, body),
  question: (id: string, text: string) => api.post(`/v1/approvals/${id}/question`, { text }),
  bulk: (items: Array<{ id: string; packetDigest: string }>, decision: 'approve' | 'reject') => api.post<{ decided: number }>('/v1/approvals/bulk', { items, decision }),
  delegate: (body: { toUser: string; endsAt: string; roleScope?: string | null; reason?: string | null }) => api.post('/v1/delegations', body),
  endDelegation: (id: string) => api.delete(`/v1/delegations/${id}`),
};

export interface Brief {
  generatedAt: string;
  decisionsAwaiting: { count: number; urgent: number; soonest: string | null; items: Array<{ id: string; title: string; riskTier: string | null; expiresAt: string }> };
  held: Array<{ id: string; runId: string; toolId: string; expiresAt: string }>;
  needsAttention: Array<{ id: string; status: string; objective: string; reason: string | null }>;
  followUps: Array<{ requestId?: string; text?: string; at: string }>;
  openIncidents: Array<{ id: string; title: string; severity: string }>;
  ranAutonomously: number;
  completedToday: number;
}

export interface TaskRow {
  id: string;
  status: string;
  objective: string;
  agentId: string;
  elapsedMs: number;
  currentStep: string | null;
  riskTier: string | null;
  holdRemainingMs: number | null;
  approvalExpiresInMs: number | null;
  reason: string | null;
  updatedAt: string;
}

export const useBrief = () => useQuery({ queryKey: approvalKeys.brief(), queryFn: () => api.get<Brief>('/v1/action-center/brief'), refetchInterval: 30_000 });
export const useTasks = () => useQuery({ queryKey: ['action-center', 'tasks'], queryFn: () => api.get<{ groups: Record<string, TaskRow[]> }>('/v1/action-center/tasks'), refetchInterval: 10_000 });
export const useSecurity = (enabled: boolean, f: { severity?: string } = {}) =>
  useQuery({ queryKey: ['action-center', 'security', f], queryFn: () => api.get<Array<{ at: string; kind: string; severity: string; title: string; runId: string | null; userId: string | null }>>(`/v1/action-center/security${f.severity ? `?severity=${f.severity}` : ''}`), enabled });
export const useUsage = () =>
  useQuery({ queryKey: ['action-center', 'usage'], queryFn: () => api.get<{ days: number; runs: number; costCents: number; monthToDateCents: number; budgetCents: number; byAgent: Array<{ key: string; runs: number; costCents: number; completed: number }>; models: Array<{ modelId: string; plans: number }>; note: string }>('/v1/action-center/usage') });
export const useAutonomy = () =>
  useQuery({ queryKey: ['action-center', 'autonomy'], queryFn: () => api.get<Array<{ agentId: string; name: string; tier: string; runs: number; autonomyRate: number | null; errorRate: number | null; meanTimeToUndoMs: number | null; promotion: { note: string } }>>('/v1/action-center/autonomy') });
export const useQuality = (enabled = true) =>
  useQuery({ queryKey: ['approval-quality'], queryFn: () => api.get<Array<{ approverId: string; approver: string; windowStart: string; decisions: number; medianLatencyMs: number; p10LatencyMs: number; evidenceOpenRate: number; highEvidenceOpenRate: number | null; editRate: number; rejectRate: number; tooFastRate: number; flag: string | null }>>('/v1/approval-quality?days=30'), enabled });

export function countdown(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}
export const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
export const msText = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`);
