'use client';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ReversibilityBadge } from '@/components/connectors/reversibility-badge';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { revActions, revKeys, useBlastRadius, type BlastGroup } from '@/lib/reversibility';

/**
 * BLAST RADIUS PANEL — docs/module6.md §6.1: what the run will DO, not its plan in prose.
 * Grouped by effect, each with its reversibility badge; external domains named; reads and money
 * stated; and the simulation's weakest fidelity reported honestly. Expand a group for the exact
 * before/after of each action.
 */

function records(a: BlastGroup['actions'][number]) {
  return a.recordsAffected.map((r) => ({ key: `${r.system}:${r.id}:${r.field ?? ''}`, text: `${r.system} ${r.id}${r.field ? ` · ${r.field}` : ''}`, before: r.before, after: r.after }));
}
const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

function Group({ g }: { g: BlastGroup }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="grid gap-1 border-b border-border py-1.5 last:border-b-0">
      <button type="button" className="flex min-w-0 flex-wrap items-center gap-2 text-left text-sm" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight aria-hidden className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="font-medium">{g.label}</span>
        {g.externalDomains.length ? (
          <span className="text-xs text-muted">
            → {g.externalDomains.length} external domain{g.externalDomains.length === 1 ? '' : 's'} ({g.externalDomains.join(', ')})
          </span>
        ) : (
          <span className="text-xs text-muted">→ inside your organization</span>
        )}
        <span className="ml-auto">
          <ReversibilityBadge value={g.reversibility} />
        </span>
      </button>
      {open ? (
        <ul className="grid gap-1.5 pl-6 text-xs">
          {g.actions.map((a) => (
            <li key={a.nodeId} className="grid gap-0.5">
              <span>{a.summary}</span>
              {a.reversibilityNote ? <span className="text-muted">{a.reversibilityNote}</span> : null}
              {records(a).map((r) => (
                <span key={r.key} className="grid grid-cols-[minmax(0,1fr)] font-mono text-[11px] text-muted">
                  <span className="truncate">{r.text}</span>
                  {r.before !== undefined || r.after !== undefined ? <span className="break-all">before {show(r.before)} → after {show(r.after)}</span> : null}
                </span>
              ))}
              {a.error ? <span className="text-risk-critical">Could not be simulated: {a.error}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function BlastRadiusPanel({ runId, compact = false }: { runId: string; compact?: boolean }) {
  const qc = useQueryClient();
  const q = useBlastRadius(runId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (q.error) return <ErrorText error={q.error} />;
  const b = q.data;
  if (!b?.summary) return compact ? null : <p className="text-sm text-muted">No preview yet: it is computed before the run starts.</p>;
  const s = b.summary;
  if (compact && !s.consequential) return null;
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await revActions.refreshBlast(runId);
      await qc.invalidateQueries({ queryKey: revKeys.blast(runId) });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="grid min-w-0 gap-1 rounded-md border border-border bg-surface p-2" aria-label="Blast radius" data-testid="blast-radius">
      <header className="flex items-center gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">This run will</h3>
        {!compact ? (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={refresh} disabled={busy}>
            <RefreshCw aria-hidden /> Simulate again
          </Button>
        ) : null}
      </header>
      {s.groups.length ? (
        <ul className="grid">
          {s.groups.map((g) => (
            <Group key={g.toolId} g={g} />
          ))}
        </ul>
      ) : (
        <p className="text-sm">Change nothing: it only reads.</p>
      )}
      <p className="text-xs">{s.financial.length ? `Money: ${s.financial.map((f) => `${f.amount} ${f.currency}`).join(', ')}` : 'No financial actions.'}</p>
      {s.reads.length ? <p className="text-xs text-muted">Reads: {s.reads.map((r) => r.label).join(', ')}</p> : null}
      <p className="text-xs text-muted" data-testid="blast-fidelity">
        {s.fidelityNote}
        {s.minFidelity === 'DECLARED' ? ' — at least one effect is only as described by its tool, not predicted.' : ''}
      </p>
      {error ? <ErrorText error={error} /> : null}
    </section>
  );
}
