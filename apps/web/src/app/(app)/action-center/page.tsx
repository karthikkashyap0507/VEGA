'use client';
import Link from 'next/link';
import { useState } from 'react';
import { ChainStatusIndicator } from '@/components/evidence/chain-status';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RiskBadge, type RiskTier } from '@/components/ui/risk-badge';
import { Select } from '@/components/ui/select';
import { Table, Td, Th } from '@/components/ui/table';
import { countdown, msText, pct, useAutonomy, useBrief, useSecurity, useTasks, useUsage, type TaskRow } from '@/lib/approvals';
import { useCan } from '@/lib/me';

/**
 * ACTION CENTER — docs/module8.md §6.4: the executive brief, active AI tasks by state, the
 * security center, AI usage, the autonomy dashboard (Module 10 fills promotion) and the evidence
 * chain's verification status (Module 7).
 */

const GROUPS: Array<{ key: string; label: string }> = [
  { key: 'AWAITING_APPROVAL', label: 'Awaiting approval' },
  { key: 'HELD', label: 'Held — can still be pulled back' },
  { key: 'NEEDS_ATTENTION', label: 'Needs attention' },
  { key: 'RUNNING', label: 'Running' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'COMPENSATED', label: 'Undone' },
  { key: 'COMPLETED', label: 'Completed' },
];

function BriefCard({ title, value, children, href }: { title: string; value: string | number; children?: React.ReactNode; href?: string }) {
  const body = (
    <Card className="h-full">
      <CardContent className="grid gap-1">
        <span className="text-xs text-muted">{title}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {children}
      </CardContent>
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
      {body}
    </Link>
  ) : (
    body
  );
}

function TaskStateGroup({ label, rows }: { label: string; rows: TaskRow[] }) {
  if (!rows.length) return null;
  return (
    <section aria-label={label} className="grid gap-1" data-testid={`tasks-${label}`}>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
        {label} ({rows.length})
      </h3>
      <ul className="grid gap-1">
        {rows.slice(0, 8).map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5 text-sm">
            <Link className="min-w-0 flex-1 truncate text-primary hover:underline" href={`/runs/${r.id}`}>
              {r.objective || r.id}
            </Link>
            {r.riskTier ? <RiskBadge tier={r.riskTier as RiskTier} /> : null}
            {r.currentStep ? <span className="text-xs text-muted">{r.currentStep}</span> : null}
            {r.holdRemainingMs !== null ? <Badge tone="info">{countdown(new Date(Date.now() + r.holdRemainingMs).toISOString())} to recall</Badge> : null}
            {r.approvalExpiresInMs !== null ? <Badge tone="info">{countdown(new Date(Date.now() + r.approvalExpiresInMs).toISOString())} to decide</Badge> : null}
            <span className="text-xs tabular-nums text-muted">{msText(r.elapsedMs)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function ActionCenterPage() {
  const can = useCan();
  const security = can('audit.read') || can('workspaces.manage');
  const [severity, setSeverity] = useState('');
  const brief = useBrief();
  const tasks = useTasks();
  const sec = useSecurity(security, severity ? { severity } : {});
  const usage = useUsage();
  const autonomy = useAutonomy();
  const b = brief.data;
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold">Action Center</h1>
          <p className="text-sm text-muted">What your agents did, what is waiting on you, what is held, and what went wrong.</p>
        </div>
        <ChainStatusIndicator />
      </header>

      {brief.error ? <ErrorText error={brief.error} /> : null}
      <section aria-label="Today's brief" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" data-testid="brief">
        <BriefCard title="Decisions awaiting you" value={b?.decisionsAwaiting.count ?? '—'} href="/approvals">
          {b?.decisionsAwaiting.urgent ? <Badge tone="danger">{b.decisionsAwaiting.urgent} urgent</Badge> : null}
          {b?.decisionsAwaiting.soonest ? <span className="text-xs text-muted">soonest expires in {countdown(b.decisionsAwaiting.soonest)}</span> : null}
        </BriefCard>
        <BriefCard title="Held — you can still pull these back" value={b?.held.length ?? '—'}>
          {b?.held[0] ? <span className="text-xs text-muted">next releases in {countdown(b.held[0].expiresAt)}</span> : null}
        </BriefCard>
        <BriefCard title="Needs attention" value={(b?.needsAttention.length ?? 0) + (b?.openIncidents.length ?? 0)}>
          {b?.followUps.length ? <span className="text-xs text-muted">{b.followUps.length} question(s) for you</span> : null}
        </BriefCard>
        <BriefCard title="Ran on its own today" value={b?.ranAutonomously ?? '—'}>
          <span className="text-xs text-muted">of {b?.completedToday ?? 0} completed</span>
        </BriefCard>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Active AI tasks</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {tasks.error ? <ErrorText error={tasks.error} /> : null}
          {GROUPS.map((g) => (
            <TaskStateGroup key={g.key} label={g.label} rows={tasks.data?.groups[g.key] ?? []} />
          ))}
          {tasks.data && !Object.values(tasks.data.groups).some((rows) => rows.length) ? <p className="text-sm text-muted">No tasks this week.</p> : null}
        </CardContent>
      </Card>

      {security ? (
        <Card>
          <CardHeader>
            <div className="grid gap-0.5">
              <CardTitle>Security center</CardTitle>
              <CardDescription>Risk events, blocked actions, approvals, policy and taint violations, failed undos — the last 14 days.</CardDescription>
            </div>
            <Select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">All severities</option>
              {['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            {sec.error ? <ErrorText error={sec.error} /> : null}
            <Table data-testid="security-events">
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th>Severity</Th>
                  <Th>Event</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {(sec.data ?? []).slice(0, 50).map((e, i) => (
                  <tr key={`${e.at}-${i}`}>
                    <Td className="whitespace-nowrap text-xs">{new Date(e.at).toLocaleString()}</Td>
                    <Td>
                      <Badge tone={e.severity === 'CRITICAL' || e.severity === 'HIGH' ? 'danger' : 'neutral'}>{e.severity}</Badge>
                    </Td>
                    <Td className="text-sm">{e.title}</Td>
                    <Td>{e.runId ? <Link className="text-xs text-primary hover:underline" href={`/runs/${e.runId}`}>run</Link> : null}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {sec.data && !sec.data.length ? <p className="p-4 text-sm text-muted">Nothing in this period.</p> : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div className="grid gap-0.5">
              <CardTitle>AI usage</CardTitle>
              <CardDescription>{usage.data?.note}</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {usage.data ? (
              <>
                <p>
                  {usage.data.runs} runs in {usage.data.days} days · ${(usage.data.costCents / 100).toFixed(2)} · this month ${(usage.data.monthToDateCents / 100).toFixed(2)}
                  {usage.data.budgetCents ? ` of $${(usage.data.budgetCents / 100).toFixed(2)}` : ''}
                </p>
                {usage.data.budgetCents ? (
                  <div className="h-2 rounded bg-surface-muted" role="meter" aria-label="Budget used" aria-valuemin={0} aria-valuemax={usage.data.budgetCents} aria-valuenow={usage.data.monthToDateCents}>
                    <div className="h-2 rounded bg-primary" style={{ width: `${Math.min(100, (usage.data.monthToDateCents / usage.data.budgetCents) * 100)}%` }} />
                  </div>
                ) : null}
                <ul className="text-xs text-muted">
                  {usage.data.models.map((m) => (
                    <li key={m.modelId}>
                      {m.modelId}: {m.plans} plan(s)
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="grid gap-0.5">
              <CardTitle>Autonomy</CardTitle>
              <CardDescription>What each agent has earned. Promotion arrives with Module 10; the rates are real today.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto p-0">
            <Table data-testid="autonomy">
              <thead>
                <tr>
                  <Th>Agent</Th>
                  <Th>Tier</Th>
                  <Th className="text-right">Runs</Th>
                  <Th className="text-right">Autonomous</Th>
                  <Th className="text-right">Errors</Th>
                  <Th className="text-right">Time-to-Undo</Th>
                </tr>
              </thead>
              <tbody>
                {(autonomy.data ?? []).map((a) => (
                  <tr key={a.agentId}>
                    <Td>{a.name}</Td>
                    <Td className="text-xs">{a.tier}</Td>
                    <Td className="text-right tabular-nums">{a.runs}</Td>
                    <Td className="text-right tabular-nums">{pct(a.autonomyRate)}</Td>
                    <Td className="text-right tabular-nums">{pct(a.errorRate)}</Td>
                    <Td className="text-right tabular-nums">{msText(a.meanTimeToUndoMs)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
