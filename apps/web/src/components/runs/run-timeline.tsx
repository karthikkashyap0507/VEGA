'use client';
import { ReversibilityBadge, type Reversibility } from '@/components/connectors/reversibility-badge';
import { ProvenanceChip } from '@/components/provenance/taint';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { NodeView } from '@/lib/runs';

/**
 * RUN TIMELINE — every task node of every program version, in order: planned (with its
 * pre-annotations), then what actually happened. Reused by the Action Center (M8).
 */

const NODE_TONE: Record<string, 'success' | 'danger' | 'neutral' | 'info'> = {
  done: 'success',
  failed: 'danger',
  unknown: 'danger',
  running: 'info',
  approving: 'info',
  held: 'info',
  pending: 'neutral',
  skipped: 'neutral',
  compensated: 'neutral',
};

function duration(n: NodeView): string | null {
  if (!n.startedAt || !n.endedAt) return null;
  const ms = Date.parse(n.endedAt) - Date.parse(n.startedAt);
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function RunTimeline({ nodes, highlightVersion }: { nodes: NodeView[]; highlightVersion?: number }) {
  if (!nodes.length) return <p className="text-sm text-muted">No steps yet — the plan appears here as soon as it is written.</p>;
  const versions = [...new Set(nodes.map((n) => n.programVersion))].sort((a, b) => a - b);
  return (
    <div className="grid gap-4" data-testid="run-timeline">
      {versions.map((v) => (
        <section key={v} className={cn('grid gap-2', highlightVersion !== undefined && v !== highlightVersion && 'opacity-70')}>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Plan v{v}</h3>
          <ol className="grid gap-1">
            {nodes
              .filter((n) => n.programVersion === v)
              .map((n) => (
                <li key={n.id} className="grid gap-1 rounded-md border border-border px-3 py-2 text-sm" data-node-status={n.status}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-6 text-xs text-muted">{n.callSeq ?? n.stepIndex + 1}</span>
                    {n.kind === 'HUMAN_INPUT' ? <strong>Waiting for your answer</strong> : <code className="font-semibold">{n.toolId}</code>}
                    <Badge tone={NODE_TONE[n.status] ?? 'neutral'}>{n.status}</Badge>
                    {n.plannedReversibility ? <ReversibilityBadge value={n.plannedReversibility as Reversibility} /> : null}
                    {n.plannedTaint ? <ProvenanceChip taint={n.plannedTaint} sourceIds={[]} label={`planned: ${n.plannedTaint.toLowerCase()}`} /> : null}
                    {n.plannedDecision === 'REQUIRE_APPROVAL' ? <Badge tone="info">approval expected</Badge> : null}
                    {duration(n) ? <span className="ml-auto text-xs text-muted">{duration(n)}</span> : null}
                  </div>
                  {n.effect?.summary ? <p className="text-xs">{n.effect.summary}</p> : null}
                  {n.effect?.replayedFrom ? <p className="text-xs text-muted">Already done in an earlier plan — not repeated.</p> : null}
                  {n.effect?.assumptions?.map((a) => (
                    <p key={a} className="text-xs text-risk-medium">
                      Assumption — {a}
                    </p>
                  ))}
                  {n.error ? <p className="text-xs text-risk-critical">{n.error.code}: {n.error.message}</p> : null}
                </li>
              ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
