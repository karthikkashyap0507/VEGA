'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, Connector, ConsentView, Tenant, ToolDeclarationRecord, ToolView, User, Workspace } from '@vega/contracts';
import { api } from './api';

type Page<T> = { items: T[]; nextCursor: string | null };

/** Every admin list, fetched whole (admin tables are small; audit tables will page — M7). */
async function all<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null = null;
  do {
    const sep = path.includes('?') ? '&' : '?';
    const page: Page<T> = await api.get<Page<T>>(`${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export const keys = {
  tenant: ['tenant'] as const,
  users: ['users'] as const,
  workspaces: ['workspaces'] as const,
  members: (id: string) => ['workspaces', id, 'members'] as const,
  agents: ['agents'] as const,
  sessions: ['sessions'] as const,
  connectors: ['connectors'] as const,
  connector: (id: string) => ['connectors', id] as const,
  catalog: ['connectors', 'catalog'] as const,
  tools: (filter: string) => ['tools', filter] as const,
  mcpTools: (id: string) => ['connectors', id, 'mcp-tools'] as const,
};

export const useTenant = () => useQuery({ queryKey: keys.tenant, queryFn: () => api.get<Tenant & { settings: Record<string, unknown> }>('/v1/tenants/current') });
export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: () => all<User>('/v1/users') });
export const useWorkspaces = () => useQuery({ queryKey: keys.workspaces, queryFn: () => all<Workspace>('/v1/workspaces?includeArchived=true') });
export const useAgents = () => useQuery({ queryKey: keys.agents, queryFn: () => all<Agent>('/v1/agents') });

// ------------------------------------------------------------------ connectors (Module 2)
export interface CatalogEntry {
  kind: Connector['kind'];
  displayName: string;
  provider: 'google' | 'microsoft' | 'slack' | 'none' | 'mcp';
  available: boolean;
  tools: ToolDeclarationRecord[];
}
export interface ConnectorHealth {
  status: Connector['status'];
  lastOkAt: string | null;
  health: Record<string, unknown>;
  events: Array<{ kind: string; detail: Record<string, unknown>; createdAt: string }>;
  invocations: { succeeded: number; failed: number; inFlight: number; p50Ms: number | null; p99Ms: number | null; errors: Array<{ code: string; count: number }> };
}
export interface McpToolRow {
  toolId: string;
  name: string;
  title: string;
  description: string;
  annotations: Record<string, unknown>;
  declaredBy: 'default' | 'admin';
  declaration: Record<string, unknown> | null;
  published: Record<string, unknown> | null;
  autonomyCap: 'SUPERVISED' | null;
  effective: ToolDeclarationRecord;
}
export const useConnectors = () => useQuery({ queryKey: keys.connectors, queryFn: () => all<Connector>('/v1/connectors') });
export const useConnector = (id: string) => useQuery({ queryKey: keys.connector(id), queryFn: () => api.get<Connector>(`/v1/connectors/${id}`) });
export const useCatalog = () =>
  useQuery({ queryKey: keys.catalog, queryFn: async () => (await api.get<{ items: CatalogEntry[] }>('/v1/connectors/catalog')).items, staleTime: 300_000 });
export const useConsent = (kind: string, tools: string[]) =>
  useQuery({
    queryKey: ['consent', kind, ...tools],
    queryFn: () => api.get<ConsentView>(`/v1/connectors/consent?kind=${encodeURIComponent(kind)}&tools=${encodeURIComponent(tools.join(','))}`),
    enabled: Boolean(kind),
  });
export const useConnectorHealth = (id: string) =>
  useQuery({ queryKey: [...keys.connector(id), 'health'], queryFn: () => api.get<ConnectorHealth>(`/v1/connectors/${id}/health`), refetchInterval: 30_000 });
export const useTools = (filter: { kind?: string; connectorId?: string } = {}) => {
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v) as Array<[string, string]>).toString();
  return useQuery({ queryKey: keys.tools(qs), queryFn: async () => (await api.get<{ items: ToolView[] }>(`/v1/tools${qs ? `?${qs}` : ''}`)).items });
};
export const useMcpTools = (id: string, enabled = true) =>
  useQuery({ queryKey: keys.mcpTools(id), queryFn: async () => (await api.get<{ items: McpToolRow[] }>(`/v1/mcp/servers/${id}/tools`)).items, enabled });

export interface Member {
  userId: string;
  workspaceId: string;
  role: 'owner' | 'admin' | 'member';
  email: string;
  displayName: string | null;
  addedAt: string;
}
export const useMembers = (workspaceId: string) =>
  useQuery({
    queryKey: keys.members(workspaceId),
    queryFn: async () => (await api.get<{ items: Member[] }>(`/v1/workspaces/${workspaceId}/members`)).items,
  });

export interface SessionRow {
  id: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
}
export const useSessions = () =>
  useQuery({ queryKey: keys.sessions, queryFn: async () => (await api.get<{ items: SessionRow[] }>('/v1/sessions')).items });

/** A mutation that refreshes the given query keys on success. */
export function useAction<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  invalidate: ReadonlyArray<readonly unknown[]>,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      await Promise.all(invalidate.map((k) => qc.invalidateQueries({ queryKey: k })));
    },
  });
}
