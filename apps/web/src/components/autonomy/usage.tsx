'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, Td, Th } from '@/components/ui/table';
import { autonomyActions, autonomyKeys, dollars, pct, useAnomalies, useBudget, useUsageBy, type Budget, type UsageBy } from '@/lib/autonomy';
import { useCan } from '@/lib/me';

/**
 * USAGE AND COST CONTROLS — docs/module10.md §12, §15.5. By user, agent, workflow, connector or
 * model; the month against its hard cap; what happens at the cap; and spend that is far above
 * its own baseline.
 *
 * Pricing discipline (PROJECT.md §22): this is shown because it is useful and because the cap is
 * enforced — it is never the basis of what anyone is charged.
 */

const BEHAVIOR: Record<Budget['breachBehavior'], { label: string; text: string }> = {
  degrade: { label: 'Switch to cheaper models', text: 'Work continues on the economy model; nothing is silently upgraded and nothing is billed beyond the cap.' },
  queue: { label: 'Queue new work', text: 'New runs wait until the cap resets or is raised; runs already in flight finish.' },
  halt: { label: 'Stop', text: 'New plans are refused and runs in flight stop at their next consequential step.' },
};

const DIM_LABEL: Record<UsageBy, string> = { agent: 'Agent', user: 'Person', workflow: 'Workflow × action', connector: 'Connector', model: 'Planning model' };

function BudgetCard() {
  const qc = useQueryClient();
  const can = useCan();
  const manage = can('budgets.manage');
  const budget = useBudget(manage || can('audit.read'));
  const [limit, setLimit] = useState<string | null>(null);
  const [behavior, setBehavior] = useState<Budget['breachBehavior'] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const b = budget.data;
  if (!manage && !can('audit.read')) return null;
  const shownLimit = limit ?? (b ? (b.configuredLimitCents / 100).toFixed(2) : '');
  const shownBehavior = behavior ?? b?.breachBehavior ?? 'queue';
  const cents = Math.round(Number(shownLimit) * 100);
  const valid = Number.isFinite(cents) && cents >= 0;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await autonomyActions.setBudget(cents, shownBehavior);
      setLimit(null);
      setBehavior(null);
      await qc.invalidateQueries({ queryKey: autonomyKeys.budget });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Monthly budget</CardTitle>
          <CardDescription>A hard cap on AI cost, and what happens when it is reached.</CardDescription>
        </div>
        {b ? <Badge tone={b.state === 'exceeded' ? 'danger' : b.state === 'warning' ? 'info' : 'neutral'}>{b.state === 'uncapped' ? 'No cap set' : b.state === 'ok' ? 'Within budget' : b.state === 'warning' ? 'Over 80% used' : 'Cap reached'}</Badge> : null}
      </CardHeader>
      <CardContent className="grid gap-3">
        {budget.error ? <ErrorText error={budget.error} /> : null}
        {b ? (
          <div className="grid gap-1 text-sm">
            <p>
              <span className="text-lg font-semibold tabular-nums">{dollars(b.spentCents)}</span>
              {b.limitCents > 0 ? <span className="text-muted"> of {dollars(b.limitCents)} this month</span> : <span className="text-muted"> this month</span>}
              <span className="text-xs text-muted"> · on this pace {dollars(b.projectedCents)}</span>
            </p>
            {b.limitCents > 0 ? (
              <div className="h-2 rounded bg-surface-muted" role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={b.limitCents} aria-valuenow={Math.min(b.spentCents, b.limitCents)}>
                <div className={`h-2 rounded ${b.state === 'exceeded' ? 'bg-danger' : 'bg-primary'}`} style={{ width: `${Math.min(100, (b.spentCents / b.limitCents) * 100)}%` }} />
              </div>
            ) : null}
          </div>
        ) : null}
        {manage ? (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) void save();
            }}
          >
            <label className="grid gap-0.5 text-xs text-muted">
              Cap (USD per month; 0 = none)
              <Input inputMode="decimal" value={shownLimit} onChange={(e) => setLimit(e.target.value)} className="w-36" />
            </label>
            <label className="grid gap-0.5 text-xs text-muted">
              At the cap
              <Select value={shownBehavior} onChange={(e) => setBehavior(e.target.value as Budget['breachBehavior'])} aria-label="At the cap">
                {(Object.keys(BEHAVIOR) as Array<Budget['breachBehavior']>).map((k) => (
                  <option key={k} value={k}>
                    {BEHAVIOR[k].label}
                  </option>
                ))}
              </Select>
            </label>
            <Button type="submit" size="sm" disabled={busy || !valid || (limit === null && behavior === null)}>
              Save
            </Button>
          </form>
        ) : null}
        <p className="text-xs text-muted">{BEHAVIOR[shownBehavior].text}</p>
        {error ? <ErrorText error={error} /> : null}
      </CardContent>
    </Card>
  );
}

function Anomalies() {
  const qc = useQueryClient();
  const can = useCan();
  const allowed = can('audit.read') || can('budgets.manage');
  const found = useAnomalies(allowed);
  const [error, setError] = useState<unknown>(null);
  if (!allowed) return null;
  const items = found.data?.items ?? [];
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Unusual spend</CardTitle>
          <CardDescription>Today’s volume or cost far above an agent’s or person’s own recent daily average.</CardDescription>
        </div>
        {can('budgets.manage') && items.length ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={async () => {
              setError(null);
              try {
                await autonomyActions.scanAnomalies();
                await qc.invalidateQueries({ queryKey: autonomyKeys.anomalies });
              } catch (e) {
                setError(e);
              }
            }}
          >
            Raise alerts
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {items.length ? (
          <ul className="grid gap-1 text-sm" data-testid="anomalies">
            {items.map((a) => (
              <li key={`${a.subjectKind}-${a.subjectId}-${a.metric}`} className="flex flex-wrap items-center gap-2">
                <Badge tone="danger">{a.factor.toFixed(1)}× usual</Badge>
                <span className="text-xs text-muted">
                  {a.subjectKind} {a.subjectId.slice(0, 8)}
                </span>
                <span>
                  {a.metric === 'runs' ? `${a.today} runs today` : `${dollars(a.today)} today`} against {a.metric === 'runs' ? `${a.baselinePerDay.toFixed(1)}` : dollars(a.baselinePerDay)} a day
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nothing unusual today.</p>
        )}
        {error ? <ErrorText error={error} /> : null}
      </CardContent>
    </Card>
  );
}

export function UsageViews() {
  const can = useCan();
  const allowed = can('audit.read') || can('budgets.manage');
  const [by, setBy] = useState<UsageBy>('agent');
  const [days, setDays] = useState(30);
  const usage = useUsageBy(by, days, allowed);
  return (
    <div className="grid gap-4">
      <BudgetCard />
      <Anomalies />
      {allowed ? (
        <Card>
          <CardHeader>
            <div className="grid gap-0.5">
              <CardTitle>Usage</CardTitle>
              <CardDescription>Runs, success, cost and governed actions — and the cost of each governed action.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Select aria-label="Group by" value={by} onChange={(e) => setBy(e.target.value as UsageBy)}>
                {(Object.keys(DIM_LABEL) as UsageBy[]).map((k) => (
                  <option key={k} value={k}>
                    {DIM_LABEL[k]}
                  </option>
                ))}
              </Select>
              <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 30, 90].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </Select>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3 p-0">
            {usage.error ? (
              <div className="px-4 pt-3">
                <ErrorText error={usage.error} />
              </div>
            ) : null}
            {usage.data ? (
              <>
                <p className="px-4 pt-3 text-sm" data-testid="usage-totals">
                  {usage.data.totals.runs} runs · {dollars(usage.data.totals.costCents)} · {usage.data.totals.governedActions} governed actions
                  {usage.data.totals.costPerGovernedActionCents !== null ? ` · ${dollars(Math.round(usage.data.totals.costPerGovernedActionCents))} each` : ''}
                </p>
                <Table data-testid="usage-table">
                  <thead>
                    <tr>
                      <Th>{DIM_LABEL[by]}</Th>
                      <Th className="text-right">{by === 'connector' ? 'Calls' : by === 'model' ? 'Runs' : 'Runs'}</Th>
                      <Th className="text-right">Success</Th>
                      <Th className="text-right">Cost</Th>
                      <Th className="text-right">{by === 'model' ? 'Plans' : 'Governed actions'}</Th>
                      <Th className="text-right">Median time</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.data.rows.map((r) => (
                      <tr key={r.key}>
                        <Td className="text-sm">{r.label ?? <span className="font-mono text-xs">{r.key.length > 40 ? r.key.slice(0, 8) : r.key}</span>}</Td>
                        <Td className="text-right tabular-nums">{r.runs}</Td>
                        <Td className="text-right tabular-nums">{pct(r.successRate)}</Td>
                        <Td className="text-right tabular-nums">{dollars(r.costCents)}</Td>
                        <Td className="text-right tabular-nums">{r.governedActions}</Td>
                        <Td className="text-right tabular-nums">{r.medianDurationMs === null ? '—' : r.medianDurationMs < 1000 ? `${r.medianDurationMs} ms` : `${(r.medianDurationMs / 1000).toFixed(1)} s`}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
                {!usage.data.rows.length ? <p className="px-4 text-sm text-muted">Nothing in this period.</p> : null}
                <ul className="px-4 pb-3 text-xs text-muted">
                  {usage.data.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
