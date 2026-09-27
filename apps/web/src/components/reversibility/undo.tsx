'use client';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Clock, RotateCcw, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { revActions, revKeys, useRunUndo, type CompensationView, type IncidentView } from '@/lib/reversibility';
import { runKeys } from '@/lib/runs';

/**
 * UNDO — docs/module6.md §6.3, §6.4. Every undo says what it will do BEFORE anyone commits to
 * it, in plain words ("…and sends a cancellation to 3 attendees. They will see that it was
 * cancelled."), whether it is exact or approximate, and for how long it stays possible. One that
 * other people will see asks for a second, explicit click. Progress is live; a failure shows
 * what failed, what state the world is in now, and exactly what to do by hand.
 */

const STATE: Record<CompensationView['state'], { text: string; Icon: typeof Clock; cls: string }> = {
  armed: { text: 'Can be undone', Icon: RotateCcw, cls: 'text-muted' },
  executing: { text: 'Undoing…', Icon: Clock, cls: 'text-primary' },
  succeeded: { text: 'Undone', Icon: CircleCheck, cls: 'text-success' },
  failed: { text: 'Undo failed', Icon: CircleX, cls: 'text-risk-critical' },
  expired: { text: 'Permanent (undo window passed)', Icon: Clock, cls: 'text-muted' },
  not_needed: { text: 'Nothing to undo', Icon: CircleCheck, cls: 'text-muted' },
};

function UndoOne({ c, runId }: { c: CompensationView; runId: string }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const s = STATE[c.state];
  const go = async (confirm: boolean) => {
    if (!c.actionId) return;
    setBusy(true);
    setError(null);
    try {
      await revActions.compensate(c.actionId, confirm);
      setConfirming(false);
      await qc.invalidateQueries({ queryKey: revKeys.undo(runId) });
    } catch (e) {
      // 428: the consequence must be confirmed first — show it and ask.
      if (e instanceof ApiError && e.status === 428) setConfirming(true);
      else setError(e);
    } finally {
      setBusy(false);
    }
  };
  const visible = c.sideEffects === 'NOTIFIES_THIRD_PARTY';
  return (
    <li className="grid gap-1 rounded-md border border-border bg-surface p-2" data-testid="undo-item" data-state={c.state}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <code className="text-xs font-semibold">{c.toolId}</code>
        <span className={`inline-flex items-center gap-1 text-xs ${s.cls}`}>
          <s.Icon aria-hidden className="size-3.5" /> {s.text}
        </span>
        {c.state === 'armed' && c.availableFor ? <span className="text-xs text-muted">· available for another {c.availableFor}</span> : null}
        {(c.state === 'armed' || c.state === 'failed') && c.undoable !== false ? (
          <Button size="sm" variant="secondary" className="ml-auto" disabled={busy || !c.actionId} onClick={() => (visible ? setConfirming(true) : go(false))}>
            <RotateCcw aria-hidden /> {c.state === 'failed' ? 'Retry undo' : 'Undo'}
          </Button>
        ) : null}
      </div>
      <p className="text-xs">{c.result?.summary ?? c.description}</p>
      {c.confidence === 'APPROXIMATE' && c.state === 'armed' ? <p className="text-xs text-muted">Approximate: undoing does not make it as if it never happened.</p> : null}
      {c.result?.residual ? <p className="text-xs text-muted">{c.result.residual}</p> : null}
      {c.result?.notified.length ? <p className="text-xs text-muted">Told: {c.result.notified.join(', ')}</p> : null}
      {c.state === 'failed' && c.lastError ? <p className="text-xs text-risk-critical">{c.lastError.message}</p> : null}
      {confirming ? (
        <div className="grid gap-2 rounded-md border border-risk-medium bg-risk-medium-bg p-2 text-sm" role="alertdialog" aria-label="Confirm undo">
          <p>
            <TriangleAlert aria-hidden className="mr-1 inline size-4 text-risk-medium" />
            {c.description}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirming(false)} disabled={busy}>
              Keep it
            </Button>
            <Button size="sm" onClick={() => go(true)} disabled={busy} data-testid="confirm-undo">
              Undo and notify them
            </Button>
          </div>
        </div>
      ) : null}
      {error ? <ErrorText error={error} /> : null}
    </li>
  );
}

export function IncidentCard({ i }: { i: IncidentView }) {
  const d = i.detail;
  return (
    <div className="grid gap-2 rounded-md border border-risk-critical bg-risk-critical-bg/40 p-3 text-sm" data-testid="incident" role="alert">
      <p className="font-semibold text-risk-critical">{i.title}</p>
      {d.error ? <p className="text-xs">What failed: {d.error.message}</p> : null}
      {d.reversed?.length || d.notAttempted?.length ? (
        <p className="text-xs">
          The state now: {d.reversed?.length ?? 0} action{d.reversed?.length === 1 ? ' was' : 's were'} undone
          {d.notAttempted?.length ? `; ${d.notAttempted.length} earlier one${d.notAttempted.length === 1 ? ' was' : 's were'} NOT undone, on purpose, until this is fixed` : ''}.
        </p>
      ) : null}
      {d.steps?.length ? (
        <div className="grid gap-1">
          <p className="text-xs font-semibold">What to do</p>
          <ol className="list-decimal pl-5 text-xs">
            {d.steps.map((s, n) => (
              <li key={n}>{s}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}

/** The run's undo panel: each consequential action, a whole-run undo, live progress, incidents. */
export function RunUndo({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const [live, setLive] = useState(false);
  const q = useRunUndo(runId, live);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const d = q.data;
  const running = Boolean(d && (d.rollbacks.some((r) => r.state === 'running') || d.compensations.some((c) => c.state === 'executing')));
  useEffect(() => setLive(running), [running]);
  if (q.error) return <ErrorText error={q.error} />;
  if (!d || (!d.compensations.length && !d.incidents.length)) return null;
  const open = d.compensations.filter((c) => c.undoable);
  const all = async (confirm: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await revActions.rollbackRun(runId, confirm);
      setConfirming(null);
      setLive(true);
      await qc.invalidateQueries({ queryKey: revKeys.undo(runId) });
      await qc.invalidateQueries({ queryKey: runKeys.run(runId) });
    } catch (e) {
      if (e instanceof ApiError && e.status === 428) setConfirming(e.problem.detail ?? 'Others will see this undo.');
      else setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid min-w-0 gap-2" aria-label="Undo" data-testid="run-undo">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Undo</h3>
        {running ? <span className="text-xs text-primary">Undoing, last action first…</span> : null}
        {open.length > 1 ? (
          <Button size="sm" variant="secondary" className="ml-auto" onClick={() => all(false)} disabled={busy}>
            <RotateCcw aria-hidden /> Undo everything this run did
          </Button>
        ) : null}
      </header>
      {confirming ? (
        <div className="grid gap-2 rounded-md border border-risk-medium bg-risk-medium-bg p-2 text-sm" role="alertdialog" aria-label="Confirm undo">
          <p>{confirming}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setConfirming(null)}>
              Keep it
            </Button>
            <Button size="sm" onClick={() => all(true)} disabled={busy}>
              Undo and notify them
            </Button>
          </div>
        </div>
      ) : null}
      {d.incidents.filter((i) => i.state !== 'resolved').map((i) => (
        <IncidentCard key={i.id} i={i} />
      ))}
      <ol className="grid gap-1.5">
        {d.compensations.map((c) => (
          <UndoOne key={c.id} c={c} runId={runId} />
        ))}
      </ol>
      {error ? <ErrorText error={error} /> : null}
    </section>
  );
}
