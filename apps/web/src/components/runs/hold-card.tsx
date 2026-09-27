'use client';
import { Hourglass, Send, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { PendingAction } from '@/lib/runs';
import { ActionCard } from './action-card';

/**
 * A HELD ACTION (docs/module5.md ALLOW_WITH_HOLD): it will run by itself when the window ends,
 * unless someone revokes it first — or releases it early. The countdown is the release time
 * the executor recorded, not a client-side guess.
 */
function remaining(releaseAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(releaseAt) - now);
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

export function HoldCard({ action, runId, busy, onRelease, onRevoke }: { action: PendingAction; runId: string; busy?: boolean; onRelease: () => void; onRevoke: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="grid gap-2" data-testid="hold-card">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Hourglass aria-hidden className="size-4 text-risk-medium" />
        {action.releaseAt ? (
          <span>
            Held — runs by itself in <span className="font-semibold tabular-nums" data-testid="hold-remaining">{remaining(action.releaseAt, now)}</span> unless you revoke it.
          </span>
        ) : (
          <span>Held until someone releases it.</span>
        )}
      </p>
      <ActionCard action={action} runId={runId} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onRelease} disabled={busy}>
          <Send aria-hidden /> Send now
        </Button>
        <Button size="sm" variant="danger" onClick={onRevoke} disabled={busy}>
          <Undo2 aria-hidden /> Revoke
        </Button>
      </div>
    </div>
  );
}
