'use client';
import { Check, PenLine, X } from 'lucide-react';
import { useState } from 'react';
import { ReversibilityBadge, type Reversibility } from '@/components/connectors/reversibility-badge';
import { ProvenanceChip } from '@/components/provenance/taint';
import { Button } from '@/components/ui/button';
import { RiskBadge, type RiskTier } from '@/components/ui/risk-badge';
import { cn } from '@/lib/utils';
import type { PendingAction, Taint } from '@/lib/runs';

/**
 * ACTION CARD — docs/module4.md §6.1: "action cards, not prose." One consequential step: what
 * it will do, how risky, how reversible, where every argument came from, and the decision.
 *
 * Designed against Module 8's decision packet and Module 6's blast radius, which reuse it:
 * `effect` is the simulated blast radius, `policy` carries M5's risk tier once it exists, and
 * the controls are approve / modify / reject — modify is shown and disabled until M8 wires it
 * (a control the system cannot yet honour is not offered as if it could).
 */

function valueText(v: unknown): string {
  if (typeof v === 'string') return v.length > 280 ? `${v.slice(0, 280)}…` : v;
  return JSON.stringify(v);
}

function argValue(args: Record<string, unknown> | undefined, path: string): unknown {
  let cur: unknown = args;
  for (const seg of path.match(/[^.[\]]+/g) ?? []) cur = cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[seg] : undefined;
  return cur;
}

export interface ActionCardProps {
  action: PendingAction;
  /** Absent: a read-only card (history, a plan preview). */
  onDecide?: ((decision: 'approve' | 'reject', note?: string) => Promise<unknown>) | undefined;
  busy?: boolean;
  className?: string;
}

export function ActionCard({ action, onDecide, busy, className }: ActionCardProps) {
  const [note, setNote] = useState('');
  const tier = (action.policy?.riskTier as RiskTier | undefined) ?? undefined;
  const leaves = action.argTaints ?? [];
  const external = action.effect?.externalRecipients ?? [];
  return (
    <article className={cn('grid gap-3 rounded-lg border border-border bg-surface p-3', className)} aria-label={`Action: ${action.toolId ?? 'step'}`} data-testid="action-card">
      <header className="flex flex-wrap items-center gap-2">
        <code className="text-sm font-semibold">{action.toolId}</code>
        {action.reversibility ? <ReversibilityBadge value={action.reversibility as Reversibility} /> : null}
        {tier ? <RiskBadge tier={tier} /> : <span className="text-xs text-muted" title="Risk scoring arrives with the policy engine (Module 5)">risk: not yet scored</span>}
        {action.argTaint ? <ProvenanceChip taint={action.argTaint} sourceIds={[...new Set(leaves.flatMap((l) => l.sourceIds))]} label={`arguments: ${action.argTaint.toLowerCase()}`} /> : null}
      </header>
      {action.effect ? (
        <p className="text-sm">
          {action.effect.summary}
          {external.length ? <span className="text-risk-high"> · leaves your organization: {external.join(', ')}</span> : null}
        </p>
      ) : null}
      {action.reason ? <p className="text-xs text-muted">Why it waits: {action.reason}</p> : null}
      {action.assumptions?.length ? (
        <ul className="rounded border border-border bg-surface-muted p-2 text-xs">
          {action.assumptions.map((a) => (
            <li key={a}>Assumption — {a}</li>
          ))}
        </ul>
      ) : null}
      {leaves.length ? (
        <dl className="grid gap-1 text-xs">
          {leaves.map((l) => (
            <div key={l.path} className="grid grid-cols-[8rem_1fr] items-baseline gap-2">
              <dt className="font-mono text-muted">{l.path}</dt>
              <dd className="flex min-w-0 flex-wrap items-baseline gap-1">
                <span className="min-w-0 break-words">{valueText(argValue(action.args, l.path))}</span>
                <ProvenanceChip taint={l.taint as Taint} sourceIds={l.sourceIds} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {onDecide ? (
        <footer className="grid gap-2">
          <label className="grid gap-1 text-xs">
            <span className="text-muted">Note (optional, recorded with the decision)</span>
            <input className="h-8 rounded-md border border-border bg-surface px-2 text-sm" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void onDecide('approve', note || undefined)} disabled={busy}>
              <Check aria-hidden /> Approve
            </Button>
            <Button size="sm" variant="secondary" disabled title="Editing a pending action arrives with the Action Center (Module 8)">
              <PenLine aria-hidden /> Modify
            </Button>
            <Button size="sm" variant="danger" onClick={() => void onDecide('reject', note || undefined)} disabled={busy}>
              <X aria-hidden /> Reject
            </Button>
          </div>
        </footer>
      ) : null}
    </article>
  );
}
