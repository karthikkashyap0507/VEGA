'use client';
import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { NodeView, ProgramVersion } from '@/lib/runs';

/**
 * PROGRAM VIEWER — the plan as the interpreter ran it (docs/module4.md §6.2): each version's
 * text, the lines whose calls executed highlighted, and a line diff between any two versions
 * (replans are new versions; M7 replays exactly these).
 */

type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** Longest-common-subsequence line diff: programs are small (≤ a few hundred lines). */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) {
      out.push({ kind: 'same', text: x[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'del', text: x[i++]! });
    else out.push({ kind: 'add', text: y[j++]! });
  }
  while (i < x.length) out.push({ kind: 'del', text: x[i++]! });
  while (j < y.length) out.push({ kind: 'add', text: y[j++]! });
  return out;
}

export function ProgramViewer({ programs, nodes }: { programs: ProgramVersion[]; nodes: NodeView[] }) {
  const latest = programs.at(-1)?.version ?? 1;
  const [version, setVersion] = useState(latest);
  const [against, setAgainst] = useState<number | null>(null);
  const current = programs.find((p) => p.version === version) ?? programs.at(-1);
  if (!current) return <p className="text-sm text-muted">No program yet.</p>;
  const executed = new Set(nodes.filter((n) => n.programVersion === current.version && n.status === 'done').map((n) => n.toolId));
  const other = against !== null ? programs.find((p) => p.version === against) : undefined;
  return (
    <div className="grid gap-2" data-testid="program-viewer">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          Version
          <select className="h-7 rounded border border-border bg-surface px-1" value={current.version} onChange={(e) => setVersion(Number(e.target.value))}>
            {programs.map((p) => (
              <option key={p.version} value={p.version}>
                v{p.version}
              </option>
            ))}
          </select>
        </label>
        {programs.length > 1 ? (
          <label className="flex items-center gap-1">
            Compare with
            <select className="h-7 rounded border border-border bg-surface px-1" value={against ?? ''} onChange={(e) => setAgainst(e.target.value ? Number(e.target.value) : null)}>
              <option value="">—</option>
              {programs
                .filter((p) => p.version !== current.version)
                .map((p) => (
                  <option key={p.version} value={p.version}>
                    v{p.version}
                  </option>
                ))}
            </select>
          </label>
        ) : null}
        <span className="text-muted">
          {current.source === 'dev_planner' ? 'development planner' : current.source} · {current.modelId} · {current.attempts ?? 1} attempt(s) · <code>{current.digest.slice(0, 19)}…</code>
        </span>
      </div>
      <pre className="overflow-x-auto rounded-md border border-border bg-surface-muted p-3 text-xs leading-5">
        {other
          ? diffLines(other.text ?? '', current.text ?? '').map((l, i) => (
              <div key={i} className={cn(l.kind === 'add' && 'bg-risk-low-bg text-risk-low', l.kind === 'del' && 'bg-risk-critical-bg text-risk-critical line-through')}>
                {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
                {l.text}
              </div>
            ))
          : (current.text ?? '').split('\n').map((line, i) => {
              const ran = [...executed].some((t) => t && line.includes(`call ${t}(`));
              return (
                <div key={i} className={cn(ran && 'bg-taint-trusted-bg')} title={ran ? 'executed' : undefined}>
                  {line}
                </div>
              );
            })}
      </pre>
    </div>
  );
}
