'use client';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleHelp, CircleX, RotateCcw } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import {
  evidenceActions,
  evidenceKeys,
  shortDigest,
  useReplays,
  type ReplayLayer,
  type ReplayResult,
} from '@/lib/evidence';
import { useCan, useMe } from '@/lib/me';
import { cn } from '@/lib/utils';

/**
 * REPLAY VIEWER — docs/module7.md §6.4: original vs replayed, side by side — program, taint
 * derivation, risk score, policy decision, model — with divergences highlighted and the
 * DETERMINISTIC layers (which must match exactly; a divergence is a bug) kept apart from the
 * model layer (pinned, replayed from the record, never asserted byte-equal).
 *
 * A replay runs in DRY mode: every tool answer comes from the recorded tape. It cannot send,
 * write or call anything.
 */

const LAYER: Record<ReplayLayer['layer'], { title: string; what: string }> = {
  interpreter: {
    title: 'Program and taint',
    what: 'The plan re-executed up to this call: same tool, same arguments, same taint on every argument.',
  },
  risk: {
    title: 'Risk score',
    what: 'The risk function on the recorded inputs and weights version.',
  },
  policy: {
    title: 'Policy decision',
    what: 'The policies in force (from their activation in the chain) evaluated on the recorded input.',
  },
  model: {
    title: 'Model',
    what: 'Pinned model and its output (the program), replayed from the record — not re-sampled.',
  },
};

function StatusIcon({ s }: { s: ReplayLayer['status'] }) {
  const I = s === 'match' ? CircleCheck : s === 'diverged' ? CircleX : CircleHelp;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-xs font-semibold',
        s === 'match' ? 'text-success' : s === 'diverged' ? 'text-danger' : 'text-muted',
      )}
    >
      <I aria-hidden className="size-4" />{' '}
      {s === 'match' ? 'Matches' : s === 'diverged' ? 'DIVERGED' : 'Inconclusive'}
    </span>
  );
}

const show = (v: unknown) =>
  v === null || v === undefined
    ? '—'
    : JSON.stringify(
        v,
        (_k, x) => (typeof x === 'string' && /^sha256:[0-9a-f]{64}$/.test(x) ? shortDigest(x) : x),
        2,
      );

function Layer({ l }: { l: ReplayLayer }) {
  return (
    <Card
      className={cn(l.status === 'diverged' && 'border-danger')}
      data-testid={`layer-${l.layer}`}
    >
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>{LAYER[l.layer].title}</CardTitle>
          <CardDescription>{LAYER[l.layer].what}</CardDescription>
        </div>
        <StatusIcon s={l.status} />
      </CardHeader>
      <CardContent className="grid gap-2">
        <p className={cn('text-sm', l.status === 'diverged' && 'text-danger')}>{l.detail}</p>
        <div className="grid gap-2 md:grid-cols-2">
          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted">Recorded</span>
            <pre className="overflow-auto rounded bg-surface-muted p-2 text-xs">
              {show(l.original)}
            </pre>
          </div>
          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted">Replayed</span>
            <pre
              className={cn(
                'overflow-auto rounded p-2 text-xs',
                l.status === 'diverged' ? 'bg-risk-critical-bg' : 'bg-surface-muted',
              )}
            >
              {show(l.replayed)}
            </pre>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Result({ r }: { r: ReplayResult }) {
  const det = r.layers.filter((l) => l.deterministic);
  const model = r.layers.filter((l) => !l.deterministic);
  return (
    <div className="grid gap-4">
      <div
        className={cn(
          'rounded-lg border px-4 py-3 text-sm',
          r.matched ? 'border-border bg-surface' : 'border-danger bg-risk-critical-bg',
        )}
        role="status"
        data-testid="replay-verdict"
      >
        <strong>
          {r.matched
            ? 'The decision reproduces exactly.'
            : det.some((l) => l.status === 'diverged')
              ? 'The replay DIVERGED from the record.'
              : 'The replay is inconclusive.'}
        </strong>{' '}
        <span className="text-muted">
          Replayed {new Date(r.createdAt).toLocaleString()} · recorded{' '}
          {shortDigest(r.originalDigest)} · replayed {shortDigest(r.replayDigest)}
          {r.toolCallsAttempted !== undefined
            ? ` · ${r.toolCallsAttempted} tool call(s) answered from the tape, none executed`
            : ''}
        </span>
      </div>
      <section className="grid gap-3" aria-label="Deterministic layers">
        <h2 className="text-sm font-semibold">Deterministic layers — must match exactly</h2>
        {det.map((l) => (
          <Layer key={l.layer} l={l} />
        ))}
      </section>
      <section className="grid gap-3" aria-label="Model layer">
        <h2 className="text-sm font-semibold">Model layer — reported, not asserted</h2>
        {model.map((l) => (
          <Layer key={l.layer} l={l} />
        ))}
      </section>
    </div>
  );
}

export default function ReplayPage() {
  const { actionId } = useParams<{ actionId: string }>();
  const id = decodeURIComponent(actionId);
  const me = useMe();
  const can = useCan();
  const qc = useQueryClient();
  const allowed = can('audit.read') && me.entitlements.exposed.deterministicReplay;
  const history = useReplays(id, allowed);
  const [current, setCurrent] = useState<ReplayResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!allowed) {
    return (
      <EmptyState
        icon={RotateCcw}
        title="Deterministic replay"
        module={can('audit.read') ? 'the Enterprise plan' : 'an audit role'}
        description="Re-run any recorded decision against the state as it was — the interpreter, the risk function and the policy evaluation must reproduce exactly."
      />
    );
  }
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setCurrent(await evidenceActions.replay(id));
      await qc.invalidateQueries({ queryKey: evidenceKeys.replays(id) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const shown = current ?? history.data?.items[0] ?? null;
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold">Replay</h1>
          <p className="font-mono text-xs text-muted">action {id}</p>
        </div>
        <Button onClick={run} disabled={busy} data-testid="replay-now">
          <RotateCcw /> {busy ? 'Replaying…' : shown ? 'Replay again' : 'Replay this decision'}
        </Button>
      </header>
      {error ? <ErrorText error={error} /> : null}
      {history.error ? <ErrorText error={history.error} /> : null}
      {shown ? <Result r={shown} /> : <p className="text-sm text-muted">Not replayed yet.</p>}
      {history.data && history.data.items.length > 1 ? (
        <p className="text-xs text-muted">
          {history.data.items.length} replays of this action:{' '}
          {history.data.items.filter((r) => r.matched).length} reproduced exactly.
        </p>
      ) : null}
    </div>
  );
}
