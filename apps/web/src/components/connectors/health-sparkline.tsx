/**
 * Event density over time (docs/module2.md §6.5): one bar per bucket, errors stacked in the
 * risk colour. Plain SVG; values are also given as text for screen readers and print.
 */
export function HealthSparkline({
  events,
  buckets = 24,
  hours = 24,
}: {
  events: Array<{ kind: string; createdAt: string }>;
  buckets?: number;
  hours?: number;
}) {
  const now = Date.now();
  const span = hours * 3600_000;
  const ok = new Array<number>(buckets).fill(0);
  const bad = new Array<number>(buckets).fill(0);
  for (const e of events) {
    const age = now - Date.parse(e.createdAt);
    if (age < 0 || age > span) continue;
    const i = Math.min(buckets - 1, Math.floor(((span - age) / span) * buckets));
    if (/error|expired|failed|rate_limited|unconfirmed/.test(e.kind)) bad[i]! += 1;
    else ok[i]! += 1;
  }
  const max = Math.max(1, ...ok.map((v, i) => v + bad[i]!));
  const errors = bad.reduce((a, b) => a + b, 0);
  return (
    <figure className="grid gap-1">
      <svg viewBox={`0 0 ${buckets * 6} 30`} className="h-8 w-full" role="img" aria-label={`${events.length} events, ${errors} problems, last ${hours}h`}>
        {ok.map((v, i) => {
          const hOk = (v / max) * 28;
          const hBad = (bad[i]! / max) * 28;
          return (
            <g key={i}>
              <rect x={i * 6} y={30 - hOk - hBad} width={4} height={hOk} className="fill-primary/60" />
              <rect x={i * 6} y={30 - hBad} width={4} height={hBad} className="fill-risk-critical" />
            </g>
          );
        })}
      </svg>
      <figcaption className="text-xs text-muted">
        Last {hours}h · {errors} problem event{errors === 1 ? '' : 's'}
      </figcaption>
    </figure>
  );
}
