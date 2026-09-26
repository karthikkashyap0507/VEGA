'use client';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Plug } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { ProvenanceChip } from '@/components/provenance/taint';
import { Button } from '@/components/ui/button';
import { runActions, runKeys, TERMINAL, useRun, useRunStream, type PendingAction } from '@/lib/runs';
import { ActionCard } from './action-card';
import { ClarificationPrompt } from './clarification-prompt';
import { StreamingStatus } from './status';

function show(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 1);
}

/**
 * One run, as the chat surface shows it: live status, the action card or clarification it is
 * waiting on, and the result with provenance chips. The inspector has everything else.
 */
export function RunCard({ runId }: { runId: string }) {
  const qc = useQueryClient();
  const q = useRun(runId);
  const run = q.data?.run;
  const stream = useRunStream(runId, Boolean(run && !TERMINAL.has(run.status)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!run) return q.error ? <ErrorText error={q.error} /> : <p className="text-xs text-muted">Starting…</p>;
  const pending = run.pending as PendingAction | null;
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: runKeys.run(runId) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const emits = run.result?.emits ?? [];
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-surface-muted/40 p-3" data-testid="run-card" data-run-status={run.status}>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <StreamingStatus connected={stream.connected} events={stream.events} status={run.status} />
        </div>
        <Link href={`/runs/${run.id}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          Inspect <ExternalLink aria-hidden className="size-3" />
        </Link>
      </div>
      {run.objective.entities.length ? (
        <p className="flex flex-wrap items-center gap-1 text-xs text-muted">
          Understood:
          {run.objective.entities.map((e) => (
            <ProvenanceChip key={e.binding} taint="TRUSTED" sourceIds={['registry:' + e.resolvedId]} label={`${e.raw} → ${e.name ?? e.email ?? e.resolvedId}`} />
          ))}
        </p>
      ) : null}
      {run.status === 'AWAITING_APPROVAL' && pending?.kind === 'approval' ? (
        <ActionCard action={pending} busy={busy} onDecide={(d, note) => act(() => runActions.decide(run.id, d, note))()} />
      ) : null}
      {run.status === 'AWAITING_INPUT' && pending?.kind === 'clarification' && pending.ambiguity ? (
        <ClarificationPrompt ambiguity={pending.ambiguity} reason={pending.reason} busy={busy} onAnswer={(field, choice) => act(() => runActions.input(run.id, field, choice))()} />
      ) : null}
      {run.status === 'AWAITING_INPUT' && pending?.kind === 'reauthorize' ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Plug aria-hidden className="size-4 text-risk-medium" />
          {pending.reason}
          <Button size="sm" variant="secondary" asChild>
            <Link href="/admin/connectors">Reconnect</Link>
          </Button>
          <Button size="sm" onClick={act(() => runActions.resume(run.id))} disabled={busy}>
            Resume
          </Button>
        </div>
      ) : null}
      {run.statusReason && ['FAILED', 'PLAN_REJECTED', 'CANCELLED', 'NEEDS_ATTENTION', 'HELD'].includes(run.status) ? <p className="text-sm text-risk-critical">{run.statusReason}</p> : null}
      {emits.length ? (
        <div className="grid gap-1" data-testid="run-result">
          {emits.map((e, i) => (
            <div key={i} className="flex flex-wrap items-baseline gap-2 text-sm">
              <span className="whitespace-pre-wrap break-words">{show(e.data)}</span>
              <ProvenanceChip taint={e.taint} sourceIds={e.sourceIds} />
            </div>
          ))}
        </div>
      ) : null}
      {!TERMINAL.has(run.status) ? (
        <div>
          <Button size="sm" variant="ghost" onClick={act(() => runActions.cancel(run.id))} disabled={busy}>
            Cancel run
          </Button>
        </div>
      ) : null}
      {error ? <ErrorText error={error} /> : null}
    </div>
  );
}
