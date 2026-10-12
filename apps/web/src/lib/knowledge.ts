'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

/** Module 9 views (docs/module9.md §8, §9), as the gateway returns them. */

export type MemoryClass = 'preference' | 'working_context' | 'task_history' | 'org_knowledge' | 'long_term_style';

export interface Memory {
  id: string;
  scope: 'user' | 'workspace' | 'tenant';
  subjectId: string;
  class: MemoryClass;
  content: string;
  provenance: { via: 'run' | 'user' | 'system'; runId: string | null; sourceIds: string[]; detail: string | null; taintAtWrite: string };
  sourceTaint: 'TRUSTED' | 'ORG';
  confidence: number | string;
  createdFromRun: string | null;
  validFrom: string;
  validTo: string | null;
  userEdited: boolean;
  pinned: boolean;
  stale: boolean;
  lastUsedAt: string | null;
  useCount: number;
}

export interface MemoryConflict {
  id: string;
  detectedAt: string;
  similarity: number;
  existing: { id: string; content: string; provenance: Memory['provenance']; userEdited: boolean };
  proposed: { content: string; class: MemoryClass; provenance: { via: string; runId?: string | null }; sourceTaint: string };
}

export interface KbDocument {
  id: string;
  title: string;
  sourceKind: string;
  mime: string;
  taint: 'TRUSTED' | 'ORG' | 'UNTRUSTED';
  sensitivity: number;
  labels: string[];
  state: 'pending' | 'indexed' | 'failed';
  error: string | null;
  chunks: number;
  workspaceId: string | null;
  indexedAt: string | null;
  createdAt: string;
}

export interface Check {
  check: string;
  outcome: 'PASS' | 'WARN' | 'ESCALATE' | 'ABORT' | 'COMPENSATE' | 'SKIPPED';
  detail: string;
  durationMs?: number;
}

export interface Verification {
  id: string;
  nodeId: string;
  toolId: string;
  phase: 'pre_commit' | 'post_commit';
  outcome: Check['outcome'];
  failedCheck: string | null;
  checksJson: Check[];
  riskTier: string | null;
  durationMs: number | null;
  createdAt: string;
  claims: number;
  unsupported: number;
}

export interface Finding {
  id: string;
  claimText: string;
  claimKind: string;
  field: string | null;
  verdict: 'SUPPORTED' | 'UNSUPPORTED' | 'CONTRADICTED';
  severity: 'INFO' | 'WARN' | 'BLOCK';
  sourceIds: string[];
}

export interface Retrieval {
  id: string;
  purpose: string;
  query: string;
  createdAt: string;
  aclFiltered: number;
  sensitivityFiltered: number;
  chunks: Array<{ id: string; removed?: boolean; title?: string; headingPath?: string[]; taint?: string; documentId?: string; score: number | null }>;
  memories: Array<{ id: string; removed?: boolean; class?: string; content?: string; taint?: string }>;
}

export const CLASS_LABEL: Record<MemoryClass, string> = {
  preference: 'Preferences',
  working_context: 'Working context',
  task_history: 'Task history',
  org_knowledge: 'Organization knowledge',
  long_term_style: 'Style',
};

export const CHECK_LABEL: Record<string, string> = {
  permissions: 'Permissions',
  policy: 'Policy',
  conflicts: 'Conflicts',
  exposure: 'Data exposure',
  consequence: 'Consequence',
  groundedness: 'Groundedness',
};

export const kKeys = {
  memories: () => ['memories'] as const,
  conflicts: () => ['memories', 'conflicts'] as const,
  documents: () => ['kb', 'documents'] as const,
};

export const useMemories = () => useQuery({ queryKey: kKeys.memories(), queryFn: () => api.get<Memory[]>('/v1/memories') });
export const useConflicts = () => useQuery({ queryKey: kKeys.conflicts(), queryFn: () => api.get<MemoryConflict[]>('/v1/memories/conflicts') });
export const useDocuments = () => useQuery({ queryKey: kKeys.documents(), queryFn: () => api.get<KbDocument[]>('/v1/kb/documents'), refetchInterval: 15_000 });
export const useAclPreview = (id: string | null) => useQuery({ queryKey: ['kb', 'acl', id], queryFn: () => api.get<Array<{ userId: string; email: string; canRead: boolean }>>(`/v1/kb/documents/${id}/acl-preview`), enabled: !!id });
export const useRunVerifications = (runId: string) => useQuery({ queryKey: ['verifications', runId], queryFn: () => api.get<Verification[]>(`/v1/runs/${runId}/verifications`), retry: false });
export const useFindings = (id: string | null) => useQuery({ queryKey: ['verifications', 'findings', id], queryFn: () => api.get<Finding[]>(`/v1/verifications/${id}/groundedness`), enabled: !!id });
export const useRetrievals = (runId: string) => useQuery({ queryKey: ['retrievals', runId], queryFn: () => api.get<Retrieval[]>(`/v1/runs/${runId}/retrievals`), retry: false });

export const knowledgeActions = {
  createMemory: (body: { class: MemoryClass; content: string; scope?: 'user' | 'workspace' | 'tenant'; workspaceId?: string }) => api.post<{ status: string }>('/v1/memories', body),
  updateMemory: (id: string, body: { content?: string; pinned?: boolean; stale?: boolean }) => api.patch(`/v1/memories/${id}`, body),
  deleteMemory: (id: string) => api.delete(`/v1/memories/${id}`),
  resolve: (id: string, resolution: 'keep_existing' | 'accept_new' | 'merge' | 'both_valid', mergedContent?: string) => api.post(`/v1/memories/conflicts/${id}/resolve`, { resolution, ...(mergedContent ? { mergedContent } : {}) }),
  exportMemories: () => api.get<{ exportedAt: string; memories: Memory[] }>('/v1/memories/export'),
  upload: (body: { title: string; mime: string; dataBase64: string; workspaceId?: string }) => api.post<{ id: string; chunks: number; state: string; error?: string }>('/v1/kb/documents', body),
  reindex: (id: string) => api.post(`/v1/kb/documents/${id}/reindex`),
  deleteDocument: (id: string) => api.delete(`/v1/kb/documents/${id}`),
};

/** File → base64 without blowing the stack on large files. */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
