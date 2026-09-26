'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Agent, Tenant, User, Workspace } from '@vega/contracts';
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
};

export const useTenant = () => useQuery({ queryKey: keys.tenant, queryFn: () => api.get<Tenant & { settings: Record<string, unknown> }>('/v1/tenants/current') });
export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: () => all<User>('/v1/users') });
export const useWorkspaces = () => useQuery({ queryKey: keys.workspaces, queryFn: () => all<Workspace>('/v1/workspaces?includeArchived=true') });
export const useAgents = () => useQuery({ queryKey: keys.agents, queryFn: () => all<Agent>('/v1/agents') });

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
