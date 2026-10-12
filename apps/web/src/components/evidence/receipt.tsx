'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { RiskBadge, type RiskTier } from '@/components/ui/risk-badge';
import { evidenceActions, shortDigest, type ChainEntry } from '@/lib/evidence';

/** A digest that opens the content it names — if the viewer may see it (§6.1 "permission-gated"). */
export function DigestLink({ digest }: { digest: string }) {
  const [state, setState] = useState<{ text: string | null; error: unknown } | null>(null);
  const open = async () => {
    try {
      const c = await evidenceActions.content(digest);
      setState({ text: c.text ?? `(${c.mediaType}, ${c.size} bytes)`, error: null });
    } catch (e) {
      setState({ text: null, error: e });
    }
  };
  return (
    <span className="inline-grid gap-1">
      <button
        type="button"
        className="font-mono text-xs text-primary underline-offset-2 hover:underline"
        onClick={open}
        title={digest}
      >
        {shortDigest(digest)}
      </button>
      {state?.text ? (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-2 text-xs">
          {pretty(state.text)}
        </pre>
      ) : null}
      {state?.error ? <ErrorText error={state.error} /> : null}
    </span>
  );
}

function pretty(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Renders a payload; every sha256 digest in it is a DigestLink. */
function Value({ v }: { v: unknown }) {
  if (typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v)) return <DigestLink digest={v} />;
  if (v === null || typeof v !== 'object')
    return <span className="font-mono text-xs">{JSON.stringify(v)}</span>;
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
  if (!entries.length)
    return <span className="font-mono text-xs">{Array.isArray(v) ? '[]' : '{}'}</span>;
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-0.5 border-l border-border pl-2">
      {entries.map(([k, x]) => (
        <div key={k} className="contents">
          <dt className="text-xs text-muted">{k}</dt>
          <dd className="min-w-0 break-words">
            <Value v={x} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The full receipt (§6.1 row expansion): payload, then what makes it verifiable. */
export function ReceiptView({ entry, canReplay }: { entry: ChainEntry; canReplay: boolean }) {
  const p = entry.payload as { risk?: { tier?: string }; action_id?: string; run_id?: string };
  return (
    <div className="grid gap-3 text-xs" data-testid="receipt">
      <div className="flex flex-wrap items-center gap-2">
        {p.risk?.tier ? <RiskBadge tier={p.risk.tier as RiskTier} /> : null}
        {p.run_id ? (
          <Link className="text-primary hover:underline" href={`/runs/${p.run_id}/trace`}>
            Run trace
          </Link>
        ) : null}
        {canReplay && entry.kind === 'action.pre' && p.action_id ? (
          <Button asChild size="sm" variant="secondary">
            <Link href={`/audit/replay/${encodeURIComponent(p.action_id)}`}>
              Replay this decision
            </Link>
          </Button>
        ) : null}
      </div>
      <Value v={entry.payload} />
      <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-3 gap-y-0.5 rounded bg-surface-muted p-2 font-mono">
        <dt className="font-sans text-muted">seq</dt>
        <dd>{entry.seq}</dd>
        <dt className="font-sans text-muted">payload digest</dt>
        <dd className="break-all">{entry.payloadDigest}</dd>
        <dt className="font-sans text-muted">prev hash</dt>
        <dd className="break-all">{entry.prevHash}</dd>
        <dt className="font-sans text-muted">entry hash</dt>
        <dd className="break-all">{entry.entryHash}</dd>
        <dt className="font-sans text-muted">signature</dt>
        <dd className="break-all">
          {entry.signature.slice(0, 48)}…{' '}
          <span className="font-sans text-muted">({entry.keyId})</span>
        </dd>
      </dl>
    </div>
  );
}
