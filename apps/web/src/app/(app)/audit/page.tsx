'use client';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FileArchive, ScrollText } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Fragment, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { ChainStatus } from '@/components/evidence/chain-status';
import { ReceiptView } from '@/components/evidence/receipt';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RiskBadge, RISK_TIERS, type RiskTier } from '@/components/ui/risk-badge';
import { Select } from '@/components/ui/select';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import {
  evidenceActions,
  facetQuery,
  KIND_LABEL,
  type ChainEntry,
  type Facets,
} from '@/lib/evidence';
import { useCan, useMe } from '@/lib/me';

/**
 * AUDIT EXPLORER — docs/module7.md §6.1. Faceted search over the signed chain (actor, agent,
 * tool, time, risk tier, decision, data subject, connector), cursor-paginated — never offset —
 * each row expanding to its full receipt with digests that open their content (bodies only for
 * audit.read_bodies), the chain status, and "export this view as an evidence pack".
 */

const FIELDS: Array<{ key: keyof Facets; label: string; placeholder: string }> = [
  { key: 'subject', label: 'Data subject', placeholder: 'peter@client.example or @client.example' },
  { key: 'toolId', label: 'Tool', placeholder: 'gmail.send' },
  { key: 'agentId', label: 'Agent', placeholder: 'agent id' },
  { key: 'actor', label: 'Person', placeholder: 'user id' },
  { key: 'runId', label: 'Run', placeholder: 'run id' },
  { key: 'connectorId', label: 'Connector', placeholder: 'connector id' },
];

const toIso = (d: string, end = false) =>
  d ? new Date(`${d}T${end ? '23:59:59.999' : '00:00:00.000'}Z`).toISOString() : undefined;

export default function AuditPage() {
  const can = useCan();
  const me = useMe();
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [facets, setFacets] = useState<Facets>({});
  const [open, setOpen] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const allowed = can('audit.read');
  const entries = useInfiniteQuery({
    queryKey: ['evidence', 'entries', facets],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      api.get<{ items: ChainEntry[]; nextCursor: number | null }>(
        `/v1/audit/entries${facetQuery({ ...facets, ...(pageParam ? { cursor: pageParam } : {}), limit: 50 })}`,
      ),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: allowed,
  });

  if (!allowed) {
    return (
      <EmptyState
        icon={ScrollText}
        title="Audit explorer"
        module="the Auditor or Compliance Officer role"
        description="Every action carries a signed, independently verifiable receipt in a tamper-evident chain. Reading it needs an audit role; your own runs’ history is on each run’s trace."
      />
    );
  }

  const apply = (e: React.FormEvent) => {
    e.preventDefault();
    setOpen(null);
    setFacets({
      ...Object.fromEntries(FIELDS.map((f) => [f.key, draft[f.key]?.trim() || undefined])),
      from: toIso(draft['from'] ?? ''),
      to: toIso(draft['to'] ?? '', true),
      kinds: draft['kind'] ? [draft['kind']] : undefined,
      riskTier: (draft['riskTier'] as RiskTier) || undefined,
      decision: draft['decision'] || undefined,
    });
  };
  const exportPack = async () => {
    setExporting(true);
    setError(null);
    try {
      await evidenceActions.buildPack({ query: facets });
      router.push('/audit/packs');
    } catch (e) {
      setError(e);
      setExporting(false);
    }
  };
  const canExport = can('evidence.export') && me.entitlements.exposed.evidencePacks;
  const rows = entries.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold">Audit</h1>
          <p className="text-sm text-muted">
            Every action, recorded before it happened, signed and chained. Tamper-evident: any
            change is detectable by anyone, offline.
          </p>
        </div>
        <div className="flex gap-2">
          {can('evidence.export') ? (
            <Button asChild variant="secondary" size="sm">
              <Link href="/audit/packs">
                <FileArchive /> Evidence packs
              </Link>
            </Button>
          ) : null}
        </div>
      </header>
      <ChainStatus />

      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>Search the chain</CardTitle>
            <CardDescription>All filters combine. Results are newest first.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={apply} className="grid gap-3" aria-label="Audit filters">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="grid gap-1">
                <Label htmlFor="f-from">From</Label>
                <Input
                  id="f-from"
                  type="date"
                  value={draft['from'] ?? ''}
                  onChange={(e) => setDraft({ ...draft, from: e.target.value })}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="f-to">To</Label>
                <Input
                  id="f-to"
                  type="date"
                  value={draft['to'] ?? ''}
                  onChange={(e) => setDraft({ ...draft, to: e.target.value })}
                />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="f-kind">Kind</Label>
                <Select
                  id="f-kind"
                  value={draft['kind'] ?? ''}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
                >
                  <option value="">Any</option>
                  {Object.entries(KIND_LABEL).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor="f-tier">Risk tier</Label>
                <Select
                  id="f-tier"
                  value={draft['riskTier'] ?? ''}
                  onChange={(e) => setDraft({ ...draft, riskTier: e.target.value })}
                >
                  <option value="">Any</option>
                  {RISK_TIERS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor="f-decision">Decision</Label>
                <Select
                  id="f-decision"
                  value={draft['decision'] ?? ''}
                  onChange={(e) => setDraft({ ...draft, decision: e.target.value })}
                >
                  <option value="">Any</option>
                  {[
                    'ALLOW',
                    'ALLOW_WITH_HOLD',
                    'HOLD',
                    'REQUIRE_APPROVAL',
                    'REQUIRE_DUAL_APPROVAL',
                    'DENY',
                  ].map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </Select>
              </div>
              {FIELDS.map((f) => (
                <div key={f.key} className="grid gap-1">
                  <Label htmlFor={`f-${f.key}`}>{f.label}</Label>
                  <Input
                    id={`f-${f.key}`}
                    placeholder={f.placeholder}
                    value={draft[f.key] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm">
                Search
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDraft({});
                  setFacets({});
                }}
              >
                Clear
              </Button>
              {canExport ? (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  onClick={exportPack}
                  disabled={exporting}
                  data-testid="export-pack"
                >
                  <FileArchive /> {exporting ? 'Starting…' : 'Export this view as an evidence pack'}
                </Button>
              ) : can('evidence.export') ? (
                <span className="ml-auto text-xs text-muted">
                  Evidence packs come with the Enterprise plan.
                </span>
              ) : null}
            </div>
            {error ? <ErrorText error={error} /> : null}
          </form>
        </CardContent>
      </Card>

      {entries.error ? <ErrorText error={entries.error} /> : null}
      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <Table data-testid="audit-entries">
          <thead>
            <tr>
              <Th className="w-6" />
              <Th>Seq</Th>
              <Th>When</Th>
              <Th>Kind</Th>
              <Th>Tool</Th>
              <Th>Decision</Th>
              <Th>Risk</Th>
              <Th>Outcome</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <Fragment key={e.seq}>
                <tr
                  className="cursor-pointer hover:bg-surface-muted"
                  onClick={() => setOpen(open === e.seq ? null : e.seq)}
                  aria-expanded={open === e.seq}
                >
                  <Td>
                    {open === e.seq ? (
                      <ChevronDown aria-hidden className="size-4" />
                    ) : (
                      <ChevronRight aria-hidden className="size-4" />
                    )}
                  </Td>
                  <Td className="tabular-nums">{e.seq.toLocaleString()}</Td>
                  <Td className="whitespace-nowrap">{new Date(e.ts).toLocaleString()}</Td>
                  <Td>{KIND_LABEL[e.kind] ?? e.kind}</Td>
                  <Td className="font-mono text-xs">{e.facets.toolId ?? '—'}</Td>
                  <Td className="text-xs">{e.facets.decision ?? '—'}</Td>
                  <Td>
                    {e.facets.riskTier ? <RiskBadge tier={e.facets.riskTier as RiskTier} /> : '—'}
                  </Td>
                  <Td className="text-xs">{e.facets.outcome ?? '—'}</Td>
                </tr>
                {open === e.seq ? (
                  <tr>
                    <td colSpan={8} className="bg-background px-4 py-3">
                      <ReceiptView
                        entry={e}
                        canReplay={me.entitlements.exposed.deterministicReplay}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </Table>
        {!entries.isLoading && !rows.length ? (
          <p className="p-4 text-sm text-muted">Nothing in the chain matches.</p>
        ) : null}
      </div>
      {entries.hasNextPage ? (
        <Button
          variant="secondary"
          size="sm"
          className="justify-self-center"
          onClick={() => entries.fetchNextPage()}
          disabled={entries.isFetchingNextPage}
        >
          {entries.isFetchingNextPage ? 'Loading…' : 'Older entries'}
        </Button>
      ) : null}
    </div>
  );
}
