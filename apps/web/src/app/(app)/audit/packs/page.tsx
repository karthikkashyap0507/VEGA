'use client';
import { useQueryClient } from '@tanstack/react-query';
import { Download, FileArchive } from 'lucide-react';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RISK_TIERS, type RiskTier } from '@/components/ui/risk-badge';
import { Select } from '@/components/ui/select';
import { Table, Td, Th } from '@/components/ui/table';
import {
  bytesText,
  evidenceActions,
  evidenceKeys,
  shortDigest,
  useEntryCount,
  usePacks,
  type Facets,
  type PackStatus,
} from '@/lib/evidence';
import { useCan, useMe } from '@/lib/me';

/**
 * EVIDENCE PACK BUILDER — docs/module7.md §6.3, §8.2: a query with a live entry count, the
 * common templates, build progress, download, history. A pack is a signed archive an auditor
 * verifies OFFLINE with the verifier inside it — the download says so.
 */

const TEMPLATES: Array<{ id: string; label: string; needs?: keyof Facets; hint?: string }> = [
  {
    id: 'client',
    label: 'Everything about this client',
    needs: 'subject',
    hint: 'their address or @domain',
  },
  { id: 'external_comms_quarter', label: 'All external communications this quarter' },
  { id: 'agent', label: 'All actions by this agent', needs: 'agentId', hint: 'the agent id' },
  { id: 'critical', label: 'All Critical-tier actions' },
];

const STAGE: Record<string, string> = {
  queued: 'Queued',
  entries: 'Reading the chain',
  redactions: 'Checking redactions',
  policies: 'Collecting the policies in force',
  anchoring: 'Anchoring the log',
  proofs: 'Computing inclusion proofs',
  content: 'Collecting content',
  assembling: 'Signing the manifest',
  storing: 'Writing to WORM storage',
};

function Status({ p }: { p: PackStatus }) {
  if (p.status === 'built') return <Badge tone="success">Built</Badge>;
  if (p.status === 'failed' || p.status === 'interrupted')
    return <Badge tone="danger">{p.status === 'failed' ? 'Failed' : 'Interrupted'}</Badge>;
  return (
    <span className="inline-flex items-center gap-2 text-xs" role="status">
      <Badge tone="info">Building</Badge>
      {p.progress
        ? `${STAGE[p.progress.stage] ?? p.progress.stage} · ${p.progress.entries.toLocaleString()} entries`
        : null}
    </span>
  );
}

const describe = (q: Facets) =>
  Object.entries(q)
    .filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
    .map(
      ([k, v]) =>
        `${k}: ${Array.isArray(v) ? v.join(', ') : k === 'from' || k === 'to' ? new Date(String(v)).toLocaleDateString() : String(v)}`,
    )
    .join(' · ') || 'Everything';

export default function PacksPage() {
  const can = useCan();
  const me = useMe();
  const qc = useQueryClient();
  const allowed = can('evidence.export') && me.entitlements.exposed.evidencePacks;
  const [template, setTemplate] = useState('');
  const [f, setF] = useState<Record<string, string>>({});
  const [bodies, setBodies] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const query: Facets = {
    ...(f['from'] ? { from: new Date(`${f['from']}T00:00:00.000Z`).toISOString() } : {}),
    ...(f['to'] ? { to: new Date(`${f['to']}T23:59:59.999Z`).toISOString() } : {}),
    ...(f['subject'] ? { subject: f['subject'].trim() } : {}),
    ...(f['agentId'] ? { agentId: f['agentId'].trim() } : {}),
    ...(f['toolId'] ? { toolId: f['toolId'].trim() } : {}),
    ...(f['riskTier'] ? { riskTier: f['riskTier'] as RiskTier } : {}),
    ...(template === 'critical' ? { riskTier: 'CRITICAL' as const } : {}),
    ...(template === 'external_comms_quarter' ? { kinds: ['action.pre', 'action.post'] } : {}),
  };
  const count = useEntryCount(query, allowed);
  const packs = usePacks(allowed);

  if (!allowed) {
    return (
      <EmptyState
        icon={FileArchive}
        title="Evidence packs"
        module={can('evidence.export') ? 'the Enterprise plan' : 'the Compliance Officer role'}
        description="A pack is a signed, filtered archive of the chain with inclusion proofs, the policies in force and a control map — verifiable offline, without contacting us. The chain itself is written on every plan."
      />
    );
  }

  const tpl = TEMPLATES.find((t) => t.id === template);
  const build = async () => {
    setBusy(true);
    setError(null);
    try {
      await evidenceActions.buildPack({
        query,
        ...(template ? { template } : {}),
        includeBodies: bodies,
      });
      await qc.invalidateQueries({ queryKey: evidenceKeys.packs() });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <header className="grid gap-1">
        <h1 className="text-lg font-semibold">Evidence packs</h1>
        <p className="text-sm text-muted">
          Signed archives of the chain for an auditor. Each carries the open-source verifier:{' '}
          <span className="font-mono">node verifier/vega-verify.mjs pack.zip</span> — offline, no
          account, no call to us.
        </p>
      </header>
      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>New pack</CardTitle>
            <CardDescription>
              Start from a template or build the query yourself. Building a pack is itself recorded
              in the chain.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Templates">
            {TEMPLATES.map((t) => (
              <Button
                key={t.id}
                size="sm"
                variant={template === t.id ? 'primary' : 'secondary'}
                aria-pressed={template === t.id}
                onClick={() => setTemplate(template === t.id ? '' : t.id)}
              >
                {t.label}
              </Button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div className="grid gap-1">
              <Label htmlFor="p-from">From</Label>
              <Input
                id="p-from"
                type="date"
                value={f['from'] ?? ''}
                onChange={(e) => setF({ ...f, from: e.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="p-to">To</Label>
              <Input
                id="p-to"
                type="date"
                value={f['to'] ?? ''}
                onChange={(e) => setF({ ...f, to: e.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="p-subject">
                Data subject{tpl?.needs === 'subject' ? ' (required)' : ''}
              </Label>
              <Input
                id="p-subject"
                placeholder="peter@client.example"
                value={f['subject'] ?? ''}
                onChange={(e) => setF({ ...f, subject: e.target.value })}
                aria-invalid={tpl?.needs === 'subject' && !f['subject']}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="p-agent">Agent{tpl?.needs === 'agentId' ? ' (required)' : ''}</Label>
              <Input
                id="p-agent"
                placeholder="agent id"
                value={f['agentId'] ?? ''}
                onChange={(e) => setF({ ...f, agentId: e.target.value })}
                aria-invalid={tpl?.needs === 'agentId' && !f['agentId']}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="p-tool">Tool</Label>
              <Input
                id="p-tool"
                placeholder="gmail.send"
                value={f['toolId'] ?? ''}
                onChange={(e) => setF({ ...f, toolId: e.target.value })}
              />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="p-tier">Risk tier</Label>
              <Select
                id="p-tier"
                value={template === 'critical' ? 'CRITICAL' : (f['riskTier'] ?? '')}
                disabled={template === 'critical'}
                onChange={(e) => setF({ ...f, riskTier: e.target.value })}
              >
                <option value="">Any</option>
                {RISK_TIERS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {can('audit.read_bodies') ? (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={bodies}
                onChange={(e) => setBodies(e.target.checked)}
              />
              Include message bodies and tool arguments (not redacted ones)
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={build}
              disabled={busy || (tpl?.needs ? !f[tpl.needs] : false)}
              data-testid="build-pack"
            >
              <FileArchive /> {busy ? 'Starting…' : 'Build pack'}
            </Button>
            <span className="text-sm text-muted" aria-live="polite" data-testid="live-count">
              {count.data
                ? `${count.data.count.toLocaleString()} entries match`
                : count.isLoading
                  ? 'Counting…'
                  : ''}
            </span>
          </div>
          {error ? <ErrorText error={error} /> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>History</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {packs.error ? <ErrorText error={packs.error} /> : null}
          {packs.data?.items.length ? (
            <Table data-testid="pack-history">
              <thead>
                <tr>
                  <Th>Requested</Th>
                  <Th>Query</Th>
                  <Th>Status</Th>
                  <Th className="text-right">Entries</Th>
                  <Th className="text-right">Size</Th>
                  <Th>Manifest</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {packs.data.items.map((p) => (
                  <tr key={p.id}>
                    <Td className="whitespace-nowrap">
                      {new Date(p.requestedAt).toLocaleString()}
                    </Td>
                    <Td className="max-w-xs text-xs">
                      {describe(p.query)}
                      {p.includeBodies ? <span className="text-muted"> · with bodies</span> : null}
                    </Td>
                    <Td>
                      <Status p={p} />
                      {p.error ? <p className="text-xs text-danger">{p.error}</p> : null}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {p.entryCount?.toLocaleString() ?? '—'}
                    </Td>
                    <Td className="text-right tabular-nums">{bytesText(p.sizeBytes)}</Td>
                    <Td className="font-mono text-xs" title={p.digest ?? undefined}>
                      {shortDigest(p.digest)}
                    </Td>
                    <Td>
                      {p.status === 'built' &&
                      (!p.expiresAt || Date.parse(p.expiresAt) > Date.now()) ? (
                        <Button asChild size="sm" variant="secondary">
                          <a href={`/v1/evidence-packs/${p.id}/download`} download>
                            <Download /> Download
                          </a>
                        </Button>
                      ) : p.status === 'built' ? (
                        <span className="text-xs text-muted">Link expired</span>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">No packs yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
