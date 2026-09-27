'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, Hourglass, PenLine, Send, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { revActions, revKeys, useHold } from '@/lib/reversibility';
import { runKeys, type PendingAction } from '@/lib/runs';
import { ActionCard } from './action-card';

/**
 * A HELD ACTION — docs/module6.md §6.2 (the window itself is M5's ALLOW_WITH_HOLD). It goes out
 * by itself when the countdown ends unless someone revokes it first. Revoke is ONE tap with no
 * confirmation — confirming a revoke defeats its purpose. "View" shows exactly what will be sent;
 * "Edit" changes the content (never the recipients) and starts the window again.
 */
function remaining(releaseAt: string, now: number): string {
  const ms = Math.max(0, Date.parse(releaseAt) - now);
  const s = Math.ceil(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

export function HoldCard({ action, runId, busy, onRelease, onRevoke }: { action: PendingAction; runId: string; busy?: boolean; onRelease: () => void; onRevoke: () => void }) {
  const qc = useQueryClient();
  const [now, setNow] = useState(() => Date.now());
  const [view, setView] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hold = useHold(action.holdId, view || editing);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const run = (fn: () => Promise<{ message?: string } | unknown>) => async () => {
    setWorking(true);
    setError(null);
    try {
      const out = (await fn()) as { message?: string; revoked?: boolean } | undefined;
      if (out && typeof out === 'object' && 'message' in out && out.revoked === false) setNotice(out.message ?? null);
      await qc.invalidateQueries({ queryKey: runKeys.run(runId) });
    } catch (e) {
      setError(e);
    } finally {
      setWorking(false);
    }
  };
  const revoke = action.holdId ? run(() => revActions.revoke(action.holdId!)) : onRevoke;
  const release = action.holdId ? run(() => revActions.release(action.holdId!)) : onRelease;
  const saveEdit = run(async () => {
    const changed = Object.fromEntries(Object.entries(draft).filter(([k, v]) => v !== String(hold.data?.artifact.args[k] ?? '')));
    const out = await revActions.edit(action.holdId!, changed);
    setEditing(false);
    await qc.invalidateQueries({ queryKey: revKeys.hold(action.holdId!) });
    return out;
  });
  const disabled = busy || working;
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
        {action.edited ? <span className="text-xs text-muted">(edited — decided again)</span> : null}
      </p>
      <ActionCard action={action} runId={runId} />
      {view && hold.data ? (
        <dl className="grid gap-1 rounded-md border border-border bg-surface p-2 text-xs" data-testid="held-content">
          {Object.entries(hold.data.artifact.args).map(([k, v]) => (
            <div key={k} className="grid grid-cols-[5rem_minmax(0,1fr)] gap-2">
              <dt className="text-muted">{k}</dt>
              <dd className="whitespace-pre-wrap break-words">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {editing && hold.data ? (
        <form
          className="grid gap-2 rounded-md border border-border bg-surface p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void saveEdit();
          }}
        >
          {hold.data.editable.map((f) => (
            <label key={f} className="grid gap-1 text-xs">
              <span className="text-muted">{f}</span>
              <textarea
                className="min-h-16 rounded-md border border-border bg-background p-1.5 text-sm"
                defaultValue={String(hold.data.artifact.args[f] ?? '')}
                onChange={(e) => setDraft((d) => ({ ...d, [f]: e.target.value }))}
                aria-label={`Edit ${f}`}
              />
            </label>
          ))}
          <p className="text-xs text-muted">Recipients cannot be changed here: revoke it and ask again. Saving starts the hold window again.</p>
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={disabled || !Object.keys(draft).length}>
              Save and hold again
            </Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="danger" onClick={revoke} disabled={disabled}>
          <Undo2 aria-hidden /> Revoke
        </Button>
        {action.holdId ? (
          <>
            <Button size="sm" variant="secondary" onClick={() => setView(!view)} disabled={disabled} aria-expanded={view}>
              <Eye aria-hidden /> {view ? 'Hide message' : 'View full message'}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(!editing)} disabled={disabled}>
              <PenLine aria-hidden /> Edit
            </Button>
          </>
        ) : null}
        <Button size="sm" onClick={release} disabled={disabled}>
          <Send aria-hidden /> Send now
        </Button>
      </div>
      {notice ? <p className="text-sm text-risk-medium">{notice}</p> : null}
      {error ? <ErrorText error={error} /> : null}
    </div>
  );
}
