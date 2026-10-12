'use client';
import { useQuery } from '@tanstack/react-query';
import { Download, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { DigestLink } from '@/components/evidence/receipt';
import { ErrorText } from '@/components/error-text';
import { ProvenanceGraph, type GraphNode } from '@/components/provenance/provenance-graph';
import { ProvenanceChip } from '@/components/provenance/taint';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { RiskBadge, type RiskTier } from '@/components/ui/risk-badge';
import { api } from '@/lib/api';
import { KIND_LABEL, useTrace } from '@/lib/evidence';
import { useMe } from '@/lib/me';

/**
 * RUN TRACE — docs/module7.md §5.9, §6.2. The six C8 questions, answered in order from the
 * SAME signed entries an evidence pack carries: what it did, why, which tools, what influenced
 * it, which policies applied, whether approval was required. The provenance graph (M3) is
 * embedded; reason chains are inline; each action links to its replay. "Same data, two
 * presentations": the export is this plus the entries it was read from.
 */

function Question({
  n,
  title,
  children,
  testId,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardHeader>
        <CardTitle>
          <span className="mr-2 text-muted">{n}</span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm">{children}</CardContent>
    </Card>
  );
}

const pretty = (v: unknown) =>
  v && typeof v === 'object' && 'redacted' in (v as object)
    ? `(${(v as { redacted: string }).redacted})`
    : JSON.stringify(v, null, 2);

export default function RunTracePage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const trace = useTrace(id);
  const graph = useQuery({
    queryKey: ['runs', id, 'provenance'],
    queryFn: () =>
      api.get<{ nodes: GraphNode[]; edges: Array<{ from: string; to: string }> }>(
        `/v1/runs/${id}/provenance`,
      ),
    retry: false,
  });
  if (trace.error) return <ErrorText error={trace.error} />;
  if (!trace.data) return <p className="text-sm text-muted">Reading the chain…</p>;
  const t = trace.data;
  const replay =
    me.entitlements.exposed.deterministicReplay && me.capabilities.includes('audit.read');
  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold">Run trace</h1>
          <p className="text-sm">
            <Link className="text-primary hover:underline" href={`/runs/${id}`}>
              Run inspector
            </Link>{' '}
            · {t.entryCount} signed entries
            {t.window.from
              ? ` · ${new Date(t.window.from).toLocaleString()} → ${new Date(t.window.to!).toLocaleString()}`
              : ''}
          </p>
          <p
            className={
              t.integrity.ok
                ? 'flex items-center gap-1 text-xs text-success'
                : 'flex items-center gap-1 text-xs font-semibold text-danger'
            }
            data-testid="trace-integrity"
          >
            {t.integrity.ok ? (
              <ShieldCheck aria-hidden className="size-4" />
            ) : (
              <ShieldAlert aria-hidden className="size-4" />
            )}
            {t.integrity.ok
              ? `Every entry of this trace checks out: hashes and signatures (${t.integrity.checked})`
              : `Entries that do NOT verify: seq ${t.integrity.failures.join(', ')}`}
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <a href={`/v1/runs/${id}/trace/export`} download={`run-${id}-trace.json`}>
            <Download /> Export (machine-readable)
          </a>
        </Button>
      </header>

      <Question n={1} title="What did it do" testId="c8-what">
        {t.what.length ? (
          <ul className="grid gap-1">
            {t.what.map((w) => (
              <li key={w.seq}>
                <span className="font-mono text-xs">{w.tool}</span> — {w.summary ?? w.outcome}{' '}
                <span className="text-xs text-muted">{new Date(w.at).toLocaleTimeString()}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">It changed nothing (reads only, or nothing was committed).</p>
        )}
        {t.compensations.length ? (
          <ul className="grid gap-1 text-xs">
            {t.compensations.map((c) => (
              <li key={c.seq}>
                {KIND_LABEL[c.kind] ?? c.kind}: <span className="font-mono">{c.tool}</span>{' '}
                {c.summary}
              </li>
            ))}
          </ul>
        ) : null}
      </Question>

      <Question n={2} title="Why" testId="c8-why">
        <p>
          {t.why.objective ?? (
            <span className="text-muted">The objective is not visible to you.</span>
          )}
        </p>
        {t.why.programs.map((p) => (
          <p key={p.seq} className="text-xs text-muted">
            Plan v{p.version} · {p.model ?? 'model unrecorded'} ·{' '}
            <span className="font-mono">{p.digest?.slice(0, 19)}…</span>
          </p>
        ))}
        <ol className="grid list-decimal gap-0.5 pl-5 text-xs">
          {t.why.steps.map((s) => (
            <li key={s.seq}>
              <span className="font-mono">{s.tool}</span>: {s.decision} —{' '}
              {s.reason ?? 'no reason recorded'}
            </li>
          ))}
        </ol>
      </Question>

      <Question n={3} title="Which tools" testId="c8-tools">
        <div className="grid gap-2">
          {t.tools.map((c) => (
            <details key={c.seq} className="rounded border border-border px-3 py-2">
              <summary className="cursor-pointer text-sm">
                <span className="font-mono">{c.tool}</span>{' '}
                <span className="text-xs text-muted">
                  · {c.reversibility} · {c.egress} · {c.outcome ?? 'no outcome recorded'}
                  {c.error ? ` (${c.error})` : ''}
                </span>
                {replay ? (
                  <Link
                    className="ml-2 text-xs text-primary hover:underline"
                    href={`/audit/replay/${encodeURIComponent(c.actionId)}`}
                  >
                    Replay
                  </Link>
                ) : null}
              </summary>
              <div className="mt-2 grid gap-1 text-xs">
                <span>
                  Arguments <DigestLink digest={c.argumentsDigest} /> · taint {c.argTaint}
                </span>
                <pre className="max-h-48 overflow-auto rounded bg-surface-muted p-2">
                  {pretty(c.arguments)}
                </pre>
                {c.effect ? (
                  <pre className="max-h-48 overflow-auto rounded bg-surface-muted p-2">
                    {pretty(c.effect)}
                  </pre>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      </Question>

      <Question n={4} title="What influenced it" testId="c8-influences">
        {t.influences.length ? (
          <div className="flex flex-wrap gap-1">
            {t.influences.map((i) => (
              <ProvenanceChip
                key={`${i.source}|${i.taint}`}
                taint={i.taint as 'TRUSTED' | 'ORG' | 'UNTRUSTED'}
                sourceIds={[i.source]}
                label={`${i.source} → ${i.actions.length} action(s)`}
              />
            ))}
          </div>
        ) : (
          <p className="text-muted">Only what you said: no retrieved content reached an action.</p>
        )}
        {graph.data?.nodes.length ? (
          <ProvenanceGraph nodes={graph.data.nodes} edges={graph.data.edges} />
        ) : null}
      </Question>

      <Question n={5} title="Which policies applied" testId="c8-policies">
        {t.policies.map((p) => (
          <div key={p.seq} className="grid gap-1 rounded border border-border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{p.tool}</span>
              <span className="text-xs font-semibold">{p.decision ?? '—'}</span>
              {p.risk?.tier ? <RiskBadge tier={p.risk.tier as RiskTier} /> : null}
              <span className="text-xs text-muted">
                decided by {p.decidedBy ?? '—'}
                {p.bundleVersion ? ` · bundle v${p.bundleVersion}` : ''}
                {p.risk?.weightsVersion ? ` · weights v${p.risk.weightsVersion}` : ''}
              </span>
            </div>
            {p.reason ? <p className="text-xs">{p.reason}</p> : null}
            {p.evaluated.length ? (
              <ul className="text-xs text-muted">
                {p.evaluated.map((e) => (
                  <li key={`${e.id}@${e.version}`}>
                    {e.id} v{e.version ?? '?'}
                    {e.citation ? ` — ${e.citation}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </Question>

      <Question n={6} title="Was approval required" testId="c8-approvals">
        {t.approvals.length ? (
          t.approvals.map((a) => (
            <p key={a.seq} className="text-xs">
              <span className="font-mono">{a.tool}</span>:{' '}
              {a.required
                ? a.granted
                  ? `approved${a.by.length ? ` by ${a.by.join(', ')}` : ''}${a.approverRole ? ` (${a.approverRole})` : ''}`
                  : 'required, not granted'
                : 'no approval required'}
              {a.hold
                ? ` · held ${Math.round(a.hold.window_ms / 1000)} s, ${a.hold.revoked ? 'revoked' : a.hold.released ? 'released' : 'pending'}`
                : ''}
              {a.evidenceDigest ? (
                <>
                  {' '}
                  · what they saw <DigestLink digest={a.evidenceDigest} />
                </>
              ) : null}
            </p>
          ))
        ) : (
          <p className="text-muted">
            No action in this run needed a person’s approval or was held.
          </p>
        )}
      </Question>

      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>Timeline</CardTitle>
            <CardDescription>Every entry, in chain order.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-0.5 text-xs">
            {t.timeline.map((e) => (
              <li key={e.seq} className="flex gap-2">
                <span className="w-14 shrink-0 tabular-nums text-muted">#{e.seq}</span>
                <span className="w-24 shrink-0 text-muted">
                  {new Date(e.ts).toLocaleTimeString()}
                </span>
                <span>{e.summary}</span>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
