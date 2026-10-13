'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, ShieldAlert, X } from 'lucide-react';
import Link from 'next/link';
import { Fragment, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, Td, Th } from '@/components/ui/table';
import { autonomyActions, autonomyKeys, gateSummary, pct, TIER_TEXT, tierText, useLadder, usePair, type LadderRow, type Tier } from '@/lib/autonomy';
import { useCan, useMe } from '@/lib/me';

/**
 * THE AUTONOMY DASHBOARD — docs/module10.md §15.1. Per workflow × action: tier, how often it ran
 * without a person, errors, days at tier, and the gate checklist that says what is left.
 *
 * Nothing on this page holds a call back. A tier is enforced by the executor; this is where a
 * person asks for evidence, ratifies a promotion, or demotes. A promotion is only ever a button
 * pressed by a named person on a certification that passed the gate.
 */

const STRICTER: Record<Tier, Tier[]> = {
  AUTONOMOUS: ['SAMPLED', 'SUPERVISED', 'SHADOW', 'SUSPENDED'],
  SAMPLED: ['SUPERVISED', 'SHADOW', 'SUSPENDED'],
  SUPERVISED: ['SHADOW', 'SUSPENDED'],
  SHADOW: ['SUSPENDED'],
  SUSPENDED: [],
};

function TierBadge({ tier, rate }: { tier: Tier; rate: number | null }) {
  const tone = tier === 'SUSPENDED' ? 'danger' : tier === 'AUTONOMOUS' || tier === 'SAMPLED' ? 'success' : 'neutral';
  return (
    <Badge tone={tone} title={TIER_TEXT[tier].meaning}>
      {tierText(tier, rate)}
    </Badge>
  );
}

function Gate({ checks }: { checks: LadderRow['gate'] }) {
  if (!checks.length) return <p className="text-xs text-muted">No certification has been run for this action yet.</p>;
  return (
    <ul className="grid gap-1" aria-label="Promotion gate">
      {checks.map((g) => (
        <li key={g.name} className="flex items-start gap-2 text-xs">
          {g.pass ? <Check aria-label="passes" className="mt-0.5 size-3.5 shrink-0 text-success" /> : <X aria-label="fails" className="mt-0.5 size-3.5 shrink-0 text-danger" />}
          <span>
            <span className="font-medium">{g.name}</span> <span className="text-muted">— {g.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function PairActions({ row }: { row: LadderRow }) {
  const qc = useQueryClient();
  const can = useCan();
  const me = useMe();
  const detail = usePair(row.workflowKey, row.actionType);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState<Tier | ''>('');
  const [reason, setReason] = useState('');
  const ladderOn = me.entitlements.exposed.certificationLadder;
  const mayDemote = can('autonomy.ratify') || can('autonomy.request_promotion');
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: autonomyKeys.ladder });
    await qc.invalidateQueries({ queryKey: autonomyKeys.pair(row.workflowKey, row.actionType) });
  };
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const cert = row.latestCertification;
  return (
    <div className="grid gap-3 bg-surface-muted/40 px-3 py-3">
      <div className="grid gap-3 md:grid-cols-2">
        <section aria-label="Gate" className="grid gap-1">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">What is left</h4>
          <Gate checks={row.gate} />
          {cert ? (
            <p className="text-xs text-muted">
              Latest certification {new Date(cert.createdAt).toLocaleDateString()} recommends <strong>{cert.recommendation}</strong>
              {cert.recommendedTier ? ` → ${TIER_TEXT[cert.recommendedTier as Tier].label}` : ''}.{' '}
              <Link className="text-primary hover:underline" href={`/autonomy/certifications/${cert.id}`}>
                Open the report
              </Link>
            </p>
          ) : null}
        </section>
        <section aria-label="History" className="grid gap-1">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">How it got here</h4>
          {detail.data?.transitions.length ? (
            <ul className="grid gap-1 text-xs">
              {detail.data.transitions.slice(0, 6).map((t) => (
                <li key={t.id}>
                  <span className="tabular-nums text-muted">{new Date(t.createdAt).toLocaleDateString()}</span>{' '}
                  {TIER_TEXT[t.fromTier].label} → <strong>{TIER_TEXT[t.toTier].label}</strong> <span className="text-muted">({t.trigger.replace('_', ' ')}{t.direction === 'DEMOTE' && !t.actorId ? ', automatic' : ''})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">No tier changes yet.</p>
          )}
        </section>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        {can('autonomy.request_promotion') ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !ladderOn}
            title={ladderOn ? undefined : 'Certification and promotion are available on the Teams plan and above. Demotion is always available.'}
            onClick={() => run(async () => void (await autonomyActions.certify(row.workflowKey, row.actionType, 30)))}
          >
            Run certification (30 days)
          </Button>
        ) : null}
        {row.eligible && cert && can('autonomy.ratify') ? (
          <Button size="sm" disabled={busy || !ladderOn} onClick={() => run(async () => void (await autonomyActions.promote(cert.id, cert.recommendedTier === 'SAMPLED' ? 5 : undefined)))}>
            Ratify promotion to {TIER_TEXT[cert.recommendedTier as Tier].label}
          </Button>
        ) : null}
        {mayDemote && STRICTER[row.tier].length ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (to && reason.trim().length >= 3) void run(async () => void (await autonomyActions.demote(row.workflowKey, row.actionType, to, reason.trim())));
            }}
          >
            <label className="grid gap-0.5 text-xs text-muted">
              Demote to
              <Select value={to} onChange={(e) => setTo(e.target.value as Tier)} aria-label="Demote to">
                <option value="">—</option>
                {STRICTER[row.tier].map((t) => (
                  <option key={t} value={t}>
                    {TIER_TEXT[t].label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="grid gap-0.5 text-xs text-muted">
              Reason
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why" className="w-56" />
            </label>
            <Button size="sm" variant="danger" type="submit" disabled={busy || !to || reason.trim().length < 3}>
              Demote
            </Button>
          </form>
        ) : null}
      </div>
      {!ladderOn ? <p className="text-xs text-muted">Certification and promotion are available on the Teams plan and above; your agents stay supervised, and you can always demote.</p> : null}
      {error ? <ErrorText error={error} /> : null}
    </div>
  );
}

export function LadderDashboard() {
  const ladder = useLadder();
  const [open, setOpen] = useState<string | null>(null);
  const rows = ladder.data?.items ?? [];
  const byAgent = new Map<string, LadderRow[]>();
  for (const r of rows) byAgent.set(r.workflowKey, [...(byAgent.get(r.workflowKey) ?? []), r]);
  return (
    <div className="grid gap-4">
      {ladder.error ? <ErrorText error={ladder.error} /> : null}
      {!ladder.isLoading && !rows.length ? (
        <Card>
          <CardContent className="grid gap-1 text-sm">
            <p className="font-medium">Nothing is on the ladder yet.</p>
            <p className="text-muted">
              Every action an agent takes starts at Shadow. Apply a team template to an agent in Agent Studio, or enroll an action, and it appears here with the evidence it needs to earn more.
            </p>
          </CardContent>
        </Card>
      ) : null}
      {[...byAgent].map(([agentId, pairs]) => (
        <Card key={agentId}>
          <CardHeader>
            <div className="grid gap-0.5">
              <CardTitle>{pairs[0]!.agentName ?? agentId}</CardTitle>
              <CardDescription>Autonomy is earned per action, not per agent: each row has its own history and its own gate.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table data-testid="ladder">
              <thead>
                <tr>
                  <Th className="w-8" />
                  <Th>Action</Th>
                  <Th>Tier</Th>
                  <Th className="text-right">Ran on its own</Th>
                  <Th className="text-right">Errors (30d)</Th>
                  <Th className="text-right">Days at tier</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {pairs.map((r) => {
                  const key = `${r.workflowKey}:${r.actionType}`;
                  const expanded = open === key;
                  return (
                    <Fragment key={key}>
                      <tr>
                        <Td>
                          <button type="button" aria-expanded={expanded} aria-label={`Details for ${r.actionType}`} className="rounded p-0.5 text-muted hover:bg-surface-muted" onClick={() => setOpen(expanded ? null : key)}>
                            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                          </button>
                        </Td>
                        <Td className="font-mono text-xs">{r.actionType}</Td>
                        <Td>
                          <TierBadge tier={r.tier} rate={r.sampleRate} />
                        </Td>
                        <Td className="text-right tabular-nums">{pct(r.autonomousRate)}</Td>
                        <Td className="text-right tabular-nums">{r.errors}</Td>
                        <Td className="text-right tabular-nums">{r.daysAtTier}</Td>
                        <Td className="max-w-xs text-xs">
                          <span className="flex items-center gap-1.5">
                            {r.tier === 'SUSPENDED' ? <ShieldAlert aria-hidden className="size-3.5 shrink-0 text-danger" /> : null}
                            <span className={r.eligible ? 'font-medium text-success' : 'text-muted'}>{gateSummary(r)}</span>
                            {r.openProposals ? <Badge tone="info">{r.openProposals} proposal{r.openProposals > 1 ? 's' : ''}</Badge> : null}
                          </span>
                        </Td>
                      </tr>
                      {expanded ? (
                        <tr>
                          <td colSpan={7} className="p-0">
                            <PairActions row={r} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
