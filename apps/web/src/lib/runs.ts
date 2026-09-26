'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AgentSpec, Ambiguity, Objective, RunStatus } from '@vega/contracts';
import { api } from './api';

/** Views of the agent core (docs/module4.md §7), as the gateway returns them. */

export type Taint = 'TRUSTED' | 'ORG' | 'UNTRUSTED';

export interface RunView {
  id: string;
  agentId: string;
  agentVersion: number;
  workspaceId: string;
  principalUserId: string;
  conversationId: string | null;
  trigger: string;
  objective: Objective;
  status: RunStatus;
  statusReason: string | null;
  programVersion: number;
  replanCount: number;
  pending: PendingAction | { kind: string; [k: string]: unknown } | null;
  result: { emits?: Array<{ data: unknown; taint: Taint; dataTaint: Taint; sourceIds: string[] }> } | null;
  error: unknown;
  costCents: number;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/** What the run is waiting on — the input to ActionCard / ClarificationPrompt (and M8's decision packet). */
export interface PendingAction {
  kind: 'approval' | 'clarification' | 'reauthorize' | 'credential' | 'hold' | 'replan' | 'attention' | 'assumptions';
  reason: string;
  key?: string;
  version?: number;
  callSeq?: number;
  dslNodeId?: string;
  toolId?: string;
  args?: Record<string, unknown>;
  argTaint?: Taint;
  argTaints?: Array<{ path: string; taint: Taint; dataTaint: Taint; sourceIds: string[] }>;
  reversibility?: 'R0' | 'R1' | 'R2' | 'R3';
  egressClass?: string;
  effect?: { summary: string; externalRecipients: string[]; recordsAffected: unknown[]; fidelity: string };
  policy?: { decision: string; reason?: string; riskTier?: string; riskScore?: number };
  assumptions?: string[];
  ambiguity?: Ambiguity;
  connector?: string;
  source?: string;
}

export interface NodeView {
  id: string;
  programVersion: number;
  stepIndex: number;
  callSeq: number | null;
  parentId: string | null;
  dslNodeId: string | null;
  kind: string;
  toolId: string | null;
  status: string;
  attempt: number;
  args: unknown;
  plannedReversibility: 'R0' | 'R1' | 'R2' | 'R3' | null;
  plannedEgress: string | null;
  plannedTaint: Taint | null;
  plannedDecision: string | null;
  plannedRisk: number | null;
  effect: { summary?: string; externalRecipients?: string[]; assumptions?: string[]; replayedFrom?: string } | null;
  error: { code?: string; message?: string } | null;
  startedAt: string | null;
  endedAt: string | null;
}

export interface ProgramVersion {
  version: number;
  digest: string;
  modelId: string;
  source: string | null;
  attempts: number | null;
  createdAt: string;
  text: string | null;
}

export interface RunDetail {
  run: RunView;
  nodes: NodeView[];
  actions: Array<{ id: string; nodeId: string; toolId: string; state: string; reversibility: string; taint: Taint; riskTier: string | null; effect: unknown; committedAt: string | null }>;
  programs: ProgramVersion[];
  replans: Array<{ id: string; fromVersion: number; fromStep: number; reason: string; detail: unknown; newProgramId: string | null; createdAt: string }>;
}

export interface Conversation {
  id: string;
  agentId: string;
  workspaceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Thread {
  conversation: Conversation;
  messages: Array<{ id: string; role: 'user' | 'agent' | 'system'; body: string; runId: string | null; createdAt: string }>;
  runs: RunView[];
}

export const TERMINAL: ReadonlySet<RunStatus> = new Set(['PLAN_REJECTED', 'COMPENSATED', 'COMPENSATION_FAILED', 'COMPLETED', 'FAILED', 'CANCELLED']);

export const runKeys = {
  run: (id: string) => ['runs', id] as const,
  list: (q: string) => ['runs', 'list', q] as const,
  conversations: ['conversations'] as const,
  thread: (id: string) => ['conversations', id] as const,
  spec: (agentId: string) => ['agents', agentId, 'spec'] as const,
};

export const useRun = (id: string, enabled = true) =>
  useQuery({
    queryKey: runKeys.run(id),
    queryFn: () => api.get<RunDetail>(`/v1/runs/${id}`),
    enabled,
    // The stream invalidates on every event; this is the fallback when SSE is unavailable.
    refetchInterval: (q) => (q.state.data && TERMINAL.has(q.state.data.run.status) ? false : 4_000),
  });

export const useRuns = (filter: { agentId?: string; status?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as Array<[string, string]>).toString();
  return useQuery({ queryKey: runKeys.list(qs), queryFn: async () => (await api.get<{ items: RunView[] }>(`/v1/runs${qs ? `?${qs}` : ''}`)).items, refetchInterval: 10_000 });
};

export const useConversations = () =>
  useQuery({ queryKey: runKeys.conversations, queryFn: async () => (await api.get<{ items: Conversation[] }>('/v1/conversations')).items });

export const useThread = (id: string | undefined) =>
  useQuery({ queryKey: runKeys.thread(id ?? ''), queryFn: () => api.get<Thread>(`/v1/conversations/${id}`), enabled: Boolean(id) });

export interface SpecView {
  agent: { id: string; name: string; status: string; version: number; workspaceId: string };
  spec: AgentSpec;
  version: number;
  versions: Array<{ version: number; createdAt: string; createdBy: string }>;
  webhookConfigured: boolean;
}
export const useAgentSpec = (agentId: string | undefined) =>
  useQuery({ queryKey: runKeys.spec(agentId ?? ''), queryFn: () => api.get<SpecView>(`/v1/agents/${agentId}/spec`), enabled: Boolean(agentId) });

export interface StreamEvent {
  id: string | null;
  kind: string;
  payload: unknown;
  at: number;
}

/**
 * Live run progress over server-sent events (/v1/runs/:id/stream). Every event refreshes the
 * run's query; the latest events are kept for the StreamingStatus line.
 */
export function useRunStream(id: string | undefined, active: boolean): { connected: boolean; events: StreamEvent[] } {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<StreamEvent[]>([]);
  useEffect(() => {
    if (!id || !active || typeof EventSource === 'undefined') return;
    const es = new EventSource(`/v1/runs/${id}/stream`);
    const onEvent = (kind: string) => (e: MessageEvent) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(String(e.data));
      } catch {
        /* keep-alive */
      }
      setEvents((prev) => [...prev.slice(-49), { id: e.lastEventId || null, kind, payload, at: Date.now() }]);
      void qc.invalidateQueries({ queryKey: runKeys.run(id) });
      if (kind === 'end') {
        es.close();
        setConnected(false);
        void qc.invalidateQueries({ queryKey: runKeys.conversations });
      }
    };
    for (const kind of ['run', 'run.status', 'run.node', 'run.started', 'run.completed', 'run.failed', 'run.awaiting_input', 'run.replanned', 'run.decision', 'run.clarified', 'action.receipt.pre', 'action.receipt.post', 'end']) {
      es.addEventListener(kind, onEvent(kind) as EventListener);
    }
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [id, active, qc]);
  return { connected, events };
}

export const runActions = {
  decide: (id: string, decision: 'approve' | 'reject', note?: string) => api.post<RunView>(`/v1/runs/${id}/decision`, { decision, ...(note ? { note } : {}) }),
  input: (id: string, field: string, choice: string) => api.post<RunView>(`/v1/runs/${id}/input`, { field, choice }),
  cancel: (id: string) => api.post<RunView>(`/v1/runs/${id}/cancel`, {}),
  resume: (id: string) => api.post<RunView>(`/v1/runs/${id}/resume`, {}),
};
