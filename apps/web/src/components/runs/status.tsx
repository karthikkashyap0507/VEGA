'use client';
import { AlertOctagon, CheckCircle2, CircleDashed, HelpCircle, Loader2, PauseCircle, RefreshCw, ShieldAlert, XCircle } from 'lucide-react';
import type { RunStatus } from '@vega/contracts';
import { cn } from '@/lib/utils';
import type { StreamEvent } from '@/lib/runs';

/** Run status: label, icon and colour together (never colour alone). */
const STATUS: Record<RunStatus, { label: string; Icon: typeof CheckCircle2; cls: string; spin?: boolean }> = {
  CREATED: { label: 'Understanding', Icon: Loader2, cls: 'text-muted', spin: true },
  PLANNING: { label: 'Planning', Icon: Loader2, cls: 'text-primary', spin: true },
  PLANNED: { label: 'Planned', Icon: CircleDashed, cls: 'text-primary' },
  PLAN_REJECTED: { label: 'Could not plan', Icon: XCircle, cls: 'text-risk-critical' },
  EXECUTING: { label: 'Running', Icon: Loader2, cls: 'text-primary', spin: true },
  AWAITING_APPROVAL: { label: 'Waiting for approval', Icon: ShieldAlert, cls: 'text-risk-high' },
  AWAITING_INPUT: { label: 'Needs your input', Icon: HelpCircle, cls: 'text-risk-medium' },
  HELD: { label: 'Held', Icon: PauseCircle, cls: 'text-risk-medium' },
  REPLANNING: { label: 'Replanning', Icon: RefreshCw, cls: 'text-primary', spin: true },
  COMPENSATING: { label: 'Undoing', Icon: RefreshCw, cls: 'text-risk-medium', spin: true },
  COMPENSATED: { label: 'Undone', Icon: CheckCircle2, cls: 'text-muted' },
  COMPENSATION_FAILED: { label: 'Undo failed', Icon: AlertOctagon, cls: 'text-risk-critical' },
  COMPLETED: { label: 'Completed', Icon: CheckCircle2, cls: 'text-success' },
  FAILED: { label: 'Failed', Icon: XCircle, cls: 'text-risk-critical' },
  CANCELLED: { label: 'Cancelled', Icon: XCircle, cls: 'text-muted' },
  NEEDS_ATTENTION: { label: 'Needs attention', Icon: AlertOctagon, cls: 'text-risk-critical' },
};

export function RunStatusBadge({ status }: { status: RunStatus }) {
  const s = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', s.cls)} data-status={status}>
      <s.Icon aria-hidden className={cn('size-3.5', s.spin && 'animate-spin')} />
      {s.label}
    </span>
  );
}

const DESCRIBE: Record<string, (p: Record<string, unknown>) => string | null> = {
  'run.status': (p) => `${String(p['from'] ?? '')} → ${String(p['to'] ?? '')}${p['reason'] ? ` (${String(p['reason'])})` : ''}`,
  'run.node': (p) => `${String(p['toolId'] ?? p['kind'] ?? 'step')}: ${String(p['status'] ?? '')}`,
  'action.receipt.pre': (p) => `receipt before ${String(p['toolId'] ?? '')}`,
  'action.receipt.post': (p) => `receipt after ${String(p['toolId'] ?? '')} (${String(p['outcome'] ?? '')})`,
  'run.decision': (p) => `decision: ${String(p['decision'] ?? '')}`,
};

/** SSE-backed progress line: what just happened, and whether the stream is live. */
export function StreamingStatus({ connected, events, status }: { connected: boolean; events: StreamEvent[]; status: RunStatus }) {
  const last = [...events].reverse().find((e) => DESCRIBE[e.kind]);
  const text = last ? DESCRIBE[last.kind]!((last.payload ?? {}) as Record<string, unknown>) : null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted" aria-live="polite">
      <RunStatusBadge status={status} />
      {text ? (
        <span className="min-w-0 flex-1 truncate" title={text}>
          {text}
        </span>
      ) : null}
      <span className={cn('ml-auto inline-flex items-center gap-1', connected ? 'text-success' : 'text-muted')} title={connected ? 'Live' : 'Not streaming'}>
        <span className={cn('size-1.5 rounded-full', connected ? 'bg-success' : 'bg-border')} />
        {connected ? 'live' : 'idle'}
      </span>
    </div>
  );
}
