/**
 * TIME-TO-UNDO — docs/module6.md §5.9: from "the user decides to undo" (the tap, or the
 * automatic failure detection) to "state restored" (the hold is cancelled for good, or the
 * provider confirmed the compensation). The user's experience is the number, not our backend's.
 * Reported per action type as median and p99, with the success rate.
 */

export interface UndoSample {
  toolId: string;
  kind: 'revoke' | 'compensate';
  durationMs: number | null;
  succeeded: boolean;
  requestedAt: Date;
}

export interface UndoStats {
  toolId: string;
  kind: 'revoke' | 'compensate';
  count: number;
  succeeded: number;
  successRate: number;
  medianMs: number | null;
  p99Ms: number | null;
  /** Median per day, oldest first: the trend line. */
  trend: Array<{ day: string; medianMs: number; count: number }>;
}

/** Nearest-rank percentile (the value a reader can find in the data). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

export function undoStats(samples: readonly UndoSample[]): UndoStats[] {
  const groups = new Map<string, UndoSample[]>();
  for (const s of samples) {
    const key = `${s.toolId}\u0000${s.kind}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const out: UndoStats[] = [];
  for (const rows of groups.values()) {
    const ok = rows.filter((r) => r.succeeded && r.durationMs !== null);
    const durations = ok.map((r) => r.durationMs!).sort((a, b) => a - b);
    const byDay = new Map<string, number[]>();
    for (const r of ok) {
      const day = r.requestedAt.toISOString().slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), r.durationMs!]);
    }
    out.push({
      toolId: rows[0]!.toolId,
      kind: rows[0]!.kind,
      count: rows.length,
      succeeded: rows.filter((r) => r.succeeded).length,
      successRate: rows.length ? rows.filter((r) => r.succeeded).length / rows.length : 1,
      medianMs: percentile(durations, 50),
      p99Ms: percentile(durations, 99),
      trend: [...byDay]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, ds]) => ({ day, medianMs: percentile([...ds].sort((a, b) => a - b), 50)!, count: ds.length })),
    });
  }
  return out.sort((a, b) => a.toolId.localeCompare(b.toolId) || a.kind.localeCompare(b.kind));
}
