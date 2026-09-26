'use client';
import { useQuery } from '@tanstack/react-query';
import { createContext, useContext } from 'react';
import type { Me } from '@vega/contracts';
import { api } from './api';

export function useMeQuery() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/v1/me'), staleTime: 60_000 });
}

const MeContext = createContext<Me | null>(null);

export const MeProvider = MeContext.Provider;

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside the authenticated shell');
  return me;
}

/**
 * UI-side capability check. This HIDES what the API would refuse; it enforces nothing. The
 * control plane re-checks every call (module1.md §5.3) — "UI-level enforcement is not
 * enforcement" (PROJECT.md §10.2 invariant 6).
 */
export function useCan() {
  const me = useMe();
  const set = new Set(me.capabilities);
  return (capability: string) => set.has(capability);
}
