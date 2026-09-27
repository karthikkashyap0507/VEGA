'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Smartphone } from 'lucide-react';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { IncidentCard } from '@/components/reversibility/undo';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { msText, revActions, revKeys, useDivergences, useIncidents, usePushTopic, useTimeToUndo, type UndoStat } from '@/lib/reversibility';

/**
 * UNDO — docs/module6.md §5.9, §6.5: Time-to-Undo per action type (the number that makes the
 * promise concrete), simulation health (divergence per tool), and incidents — a failed undo is
 * never a silent log line.
 */

/** A single-series trend of the daily median: one hue, 2px line, the latest point marked, values on hover. */
function Trend({ points }: { points: UndoStat['trend'] }) {
  if (points.length < 2) return <span className="text-xs text-muted">—</span>;
  const w = 96;
  const h = 24;
  const max = Math.max(...points.map((p) => p.medianMs), 1);
  const xy = points.map((p, i) => [4 + (i * (w - 8)) / (points.length - 1), h - 4 - (p.medianMs / max) * (h - 8)] as const);
  return (
    <svg width={w} height={h} role="img" aria-label={`Daily median over ${points.length} days, latest ${msText(points.at(-1)!.medianMs)}`}>
      <polyline points={xy.map(([x, y]) => `${x},${y}`).join(' ')} fill="none" stroke="var(--primary)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {xy.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i === xy.length - 1 ? 3 : 6} fill={i === xy.length - 1 ? 'var(--primary)' : 'transparent'}>
          <title>
            {points[i]!.day}: median {msText(points[i]!.medianMs)} ({points[i]!.count})
          </title>
        </circle>
      ))}
    </svg>
  );
}

export default function UndoAdminPage() {
  const qc = useQueryClient();
  const [days, setDays] = useState(30);
  const ttu = useTimeToUndo(days);
  const div = useDivergences();
  const inc = useIncidents();
  const push = usePushTopic();
  const [error, setError] = useState<unknown>(null);
  const act = (fn: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: revKeys.incidents() });
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Time-to-Undo</CardTitle>
          <CardDescription>From the moment someone decides to undo to the moment the state is restored — measured on the person’s side, per action type.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2">
          <div className="flex gap-1" role="group" aria-label="Period">
            {[7, 30, 90].map((d) => (
              <Button key={d} size="sm" variant={d === days ? 'primary' : 'ghost'} onClick={() => setDays(d)} aria-pressed={d === days}>
                {d} days
              </Button>
            ))}
          </div>
          {ttu.error ? <ErrorText error={ttu.error} /> : null}
          {ttu.data?.items.length ? (
            <div className="overflow-x-auto">
              <Table data-testid="ttu-table">
                <thead>
                  <tr>
                    <Th>Action</Th>
                    <Th>How</Th>
                    <Th className="text-right">Median</Th>
                    <Th className="text-right">p99</Th>
                    <Th className="text-right">Succeeded</Th>
                    <Th>Trend (daily median)</Th>
                  </tr>
                </thead>
                <tbody>
                  {ttu.data.items.map((s) => (
                    <tr key={`${s.toolId}:${s.kind}`}>
                      <Td className="font-mono text-xs">{s.toolId}</Td>
                      <Td>{s.kind === 'revoke' ? 'Revoked in its hold' : 'Compensated'}</Td>
                      <Td className="text-right tabular-nums">{msText(s.medianMs)}</Td>
                      <Td className="text-right tabular-nums">{msText(s.p99Ms)}</Td>
                      <Td className="text-right tabular-nums">
                        {s.succeeded}/{s.count} ({Math.round(s.successRate * 100)}%)
                      </Td>
                      <Td>
                        <Trend points={s.trend} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted">Nothing undone in this period.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Incidents</CardTitle>
          <CardDescription>Undos that failed and holds that could not be settled. Each says what happened, the state now, and what to do.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {inc.data?.filter((i) => i.state !== 'resolved').length ? (
            inc.data
              .filter((i) => i.state !== 'resolved')
              .map((i) => (
                <div key={i.id} className="grid gap-2">
                  <IncidentCard i={i} />
                  <div className="flex gap-2">
                    {i.state === 'open' ? (
                      <Button size="sm" variant="secondary" onClick={act(() => revActions.acknowledge(i.id))}>
                        Acknowledge
                      </Button>
                    ) : null}
                    <Button size="sm" variant="secondary" onClick={act(() => revActions.resolve(i.id, 'Put right by hand, following the steps.'))}>
                      Mark resolved
                    </Button>
                  </div>
                </div>
              ))
          ) : (
            <p className="text-sm text-muted">No open incidents.</p>
          )}
          {error ? <ErrorText error={error} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Simulation health</CardTitle>
          <CardDescription>How often an action did something other than its simulation said. A rising rate means a tool needs attention; a mismatch in who is reached stops the run and undoes it.</CardDescription>
        </CardHeader>
        <CardContent>
          {div.data?.rates.length ? (
            <div className="overflow-x-auto">
              <Table>
                <thead>
                  <tr>
                    <Th>Tool</Th>
                    <Th className="text-right">Actions</Th>
                    <Th className="text-right">Divergences</Th>
                    <Th className="text-right">Stopped a run</Th>
                  </tr>
                </thead>
                <tbody>
                  {div.data.rates.map((r) => (
                    <tr key={r.toolId}>
                      <Td className="font-mono text-xs">{r.toolId}</Td>
                      <Td className="text-right tabular-nums">{r.actions}</Td>
                      <Td className="text-right tabular-nums">{r.divergences}</Td>
                      <Td className="text-right tabular-nums">{r.aborts}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : (
            <p className="text-sm text-muted">No actions in the last 30 days.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Smartphone aria-hidden className="size-4" /> Revoke from your phone
          </CardTitle>
          <CardDescription>Held actions are pushed to your phone with a Revoke button that works in one tap, without signing in.</CardDescription>
        </CardHeader>
        <CardContent className="text-sm">
          {push.data?.topic ? (
            <p>
              In the ntfy app, subscribe to <code className="rounded bg-surface-muted px-1 font-mono text-xs">{push.data.topic}</code>. Keep it private: anyone subscribed can stop your held actions (never send them).
            </p>
          ) : (
            <p className="text-muted">Push notifications are not configured for this deployment.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
