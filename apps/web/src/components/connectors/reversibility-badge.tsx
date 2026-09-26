import { Eye, RotateCcw, Timer, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Reversibility class — PROJECT.md §7.5, docs/module2.md §6.5. Reused everywhere from Module 6
 * on. Like RiskBadge: label, icon AND colour together, never colour alone.
 */
export type Reversibility = 'R0' | 'R1' | 'R2' | 'R3';

export const REVERSIBILITY: Record<Reversibility, { label: string; plain: string; Icon: typeof Eye; cls: string }> = {
  R0: { label: 'Read-only', plain: 'Changes nothing. Nothing to undo.', Icon: Eye, cls: 'bg-surface-muted text-muted' },
  R1: { label: 'Undoable', plain: 'Can be undone automatically, completely.', Icon: RotateCcw, cls: 'bg-risk-low-bg text-risk-low' },
  R2: {
    label: 'Held, then final',
    plain: 'Held before release with a window to pull it back; after that, undo is approximate (the other side may already have seen it).',
    Icon: Timer,
    cls: 'bg-risk-medium-bg text-risk-medium',
  },
  R3: { label: 'Irreversible', plain: 'Cannot be undone once it happens. Requires approval by default.', Icon: TriangleAlert, cls: 'bg-risk-critical-bg text-risk-critical' },
};

export function ReversibilityBadge({ value, explain = false }: { value: Reversibility; explain?: boolean }) {
  const r = REVERSIBILITY[value];
  return (
    <span className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold', r.cls)} title={r.plain}>
      <r.Icon aria-hidden className="size-3.5" />
      <span>
        {value} · {r.label}
      </span>
      {explain ? <span className="font-normal">— {r.plain}</span> : null}
    </span>
  );
}
