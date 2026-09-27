'use client';
import { useEffect, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RiskBadge } from '@/components/ui/risk-badge';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/me';
import { useAction } from '@/lib/queries';
import { policyKeys, useWeights, type Tier, type Weights } from '@/lib/policy';

/**
 * RISK WEIGHTS — docs/module5.md §6.4. Tenant-tunable within bounds, with a live preview against
 * recent actions showing how the tier distribution would shift. Saving creates a new version;
 * history keeps the version it was scored with (replay recomputes with the recorded weights).
 */

const FACTORS: Array<{ key: 'w1' | 'w2' | 'w3' | 'w4' | 'w5' | 'w6' | 'w7'; label: string; hint: string }> = [
  { key: 'w1', label: 'Data sensitivity', hint: 'PII/PHI/credentials found in what is sent (Presidio)' },
  { key: 'w2', label: 'Blast radius', hint: 'recipients, records, money' },
  { key: 'w3', label: 'External exposure', hint: 'internal / external / public' },
  { key: 'w4', label: 'Irreversibility', hint: 'R0 read … R3 cannot be undone' },
  { key: 'w5', label: 'Authority gap', hint: 'the action outranks the person it acts for' },
  { key: 'w6', label: 'Taint pressure', hint: 'arguments derived from untrusted content' },
  { key: 'w7', label: 'Certification credit', hint: 'subtracts: earned agreement rate (Module 10)' },
];
const TIERS: Tier[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

type Preview = { actions: number; before: Record<Tier, number>; after: Record<Tier, number>; moved: number };

function Distribution({ label, counts, total }: { label: string; counts: Record<Tier, number>; total: number }) {
  return (
    <div className="grid gap-1">
      <p className="text-xs font-semibold">{label}</p>
      {TIERS.map((t) => {
        const n = counts[t] ?? 0;
        const pct = total ? Math.round((n / total) * 100) : 0;
        return (
          <div key={t} className="grid grid-cols-[7rem_3rem_1fr] items-center gap-2 text-xs">
            <RiskBadge tier={t} />
            <span className="text-right tabular-nums">{n}</span>
            <span className="font-mono" aria-label={`${pct}%`}>
              {'█'.repeat(Math.round(pct / 5))}
              <span className="text-muted"> {pct}%</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function RiskPage() {
  const can = useCan();
  const q = useWeights();
  const [draft, setDraft] = useState<Weights | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<unknown>(null);
  useEffect(() => {
    if (q.data && !draft) setDraft(q.data.weights);
  }, [q.data, draft]);
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(() => {
      const { version: _v, ...w } = draft;
      api.post<Preview>('/v1/risk/weights/preview', { ...w, days: 30 }).then(
        (p) => (setPreview(p), setPreviewError(null)),
        (e: unknown) => setPreviewError(e),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [draft]);
  const save = useAction(() => {
    const { version: _v, ...w } = draft!;
    return api.put('/v1/risk/weights', w);
  }, [policyKeys.weights]);
  if (!q.data || !draft) return q.error ? <ErrorText error={q.error} /> : <p className="text-sm text-muted">Loading…</p>;
  const bounds = q.data.bounds;
  const manage = can('policy.manage');
  const changed = JSON.stringify(draft) !== JSON.stringify(q.data.weights);
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Risk weights — v{q.data.weights.version}{q.data.tenantOwned ? ' (yours)' : ' (platform default)'}</CardTitle>
          <CardDescription>
            The score is a transparent function, never a model: each factor is 0–100, multiplied by its weight. Bounds keep any factor from being zeroed out or made to dominate. Hard gates apply whatever the score.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <div className="grid gap-2">
            {FACTORS.map((f) => (
              <label key={f.key} className="grid gap-0.5 text-xs">
                <span className="flex justify-between">
                  <span>
                    {f.label} <span className="text-muted">— {f.hint}</span>
                  </span>
                  <span className="font-mono tabular-nums">{draft[f.key].toFixed(2)}</span>
                </span>
                <input
                  type="range"
                  aria-label={f.label}
                  min={bounds[f.key]!.min}
                  max={bounds[f.key]!.max}
                  step={0.05}
                  value={draft[f.key]}
                  disabled={!manage}
                  onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                />
              </label>
            ))}
            <fieldset className="grid grid-cols-3 gap-2 text-xs">
              <legend className="mb-1">Tier boundaries (LOW &lt; low ≤ MEDIUM &lt; medium ≤ HIGH &lt; high ≤ CRITICAL)</legend>
              {(['low', 'medium', 'high'] as const).map((b) => (
                <label key={b} className="grid gap-0.5">
                  {b}
                  <input
                    type="number"
                    className="h-8 rounded-md border border-border bg-surface px-2"
                    min={1}
                    max={99}
                    value={draft.boundaries[b]}
                    disabled={!manage}
                    onChange={(e) => setDraft({ ...draft, boundaries: { ...draft.boundaries, [b]: Number(e.target.value) } })}
                  />
                </label>
              ))}
            </fieldset>
          </div>
          <div className="grid content-start gap-3" aria-live="polite" data-testid="weights-preview">
            {preview ? (
              <>
                <p className="text-xs">
                  Recent actions (30 days): {preview.actions} · <span className="font-semibold">{preview.moved}</span> would change tier.
                </p>
                <Distribution label="As scored" counts={preview.before} total={preview.actions} />
                <Distribution label="With these weights" counts={preview.after} total={preview.actions} />
              </>
            ) : null}
            <ErrorText error={previewError} />
          </div>
        </CardContent>
      </Card>
      {manage ? (
        <div className="flex items-center gap-2">
          <Button disabled={!changed || save.isPending} onClick={async () => void (await save.mutateAsync(undefined).then(() => setDraft(null)).catch(() => undefined))}>
            Save as a new version
          </Button>
          <Button variant="ghost" disabled={!changed} onClick={() => setDraft(q.data.weights)}>
            Discard
          </Button>
          <ErrorText error={save.error} />
        </div>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <thead>
              <tr>
                <Th>Version</Th>
                <Th>Owner</Th>
                <Th>Weights</Th>
                <Th>Boundaries</Th>
                <Th>From</Th>
              </tr>
            </thead>
            <tbody>
              {q.data.history.map((h) => (
                <tr key={h.version}>
                  <Td>v{h.version}</Td>
                  <Td className="text-xs">{h.tenantOwned ? 'this organization' : 'platform default'}</Td>
                  <Td className="font-mono text-xs">{FACTORS.map((f) => h.weights[f.key].toFixed(2)).join(' · ')}</Td>
                  <Td className="font-mono text-xs">
                    {h.weights.boundaries.low}/{h.weights.boundaries.medium}/{h.weights.boundaries.high}
                  </Td>
                  <Td className="text-xs">{new Date(h.activeFrom).toLocaleString()}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
