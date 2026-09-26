'use client';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { Shell } from '@/components/shell';
import { ApiError } from '@/lib/api';
import { MeProvider, useMeQuery } from '@/lib/me';

/**
 * Authenticated shell. The session cookie is httpOnly, so the only way to know whether the
 * user is signed in is to ask the API. A 401 sends them to /login with a return path.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const me = useMeQuery();
  const unauthenticated = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    if (unauthenticated) window.location.href = `/login?returnTo=${encodeURIComponent(path)}`;
  }, [unauthenticated, path]);

  if (me.isPending || unauthenticated) {
    return (
      <div className="grid min-h-dvh place-items-center text-sm text-muted" aria-busy="true">
        Loading your workspace…
      </div>
    );
  }
  if (me.error) {
    return (
      <div role="alert" className="grid min-h-dvh place-items-center px-4 text-center text-sm">
        <div className="grid gap-2">
          <p className="font-medium">The service is not reachable right now.</p>
          <p className="text-muted">{me.error.message}</p>
        </div>
      </div>
    );
  }
  return (
    <MeProvider value={me.data}>
      <Shell>{children}</Shell>
    </MeProvider>
  );
}
