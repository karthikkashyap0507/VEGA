'use client';
import { ArrowLeft, FlaskConical, Rocket } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { ReasonChain } from '@/components/policy/risk-explanation';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useCan } from '@/lib/me';
import { useAction } from '@/lib/queries';
import { CHANGE_TEXT, DECISION_TEXT, policyKeys, useBundles, useSimulation, type ChangeKind, type Simulation } from '@/lib/policy';

/**
 * POLICY SIMULATOR — docs/module5.md §5.8, §6.2. Replays the recorded actions of a window
 * against a candidate bundle and reports what would change, grouped by kind; each changed action
 * links to its run and shows the old and new reason chains side by side. Simulation is the
 * required gate before activation.
 */

const ORDER: ChangeKind[] = ['newly_denied', 'newly_requires_approval', 'newly_held', 'more_restrictive', 'less_restrictive', 'newly_automatic'];
const SIGN: Record<ChangeKind, string> = { newly_denied: '+', newly_requires_approval: '+', newly_held: '+', more_restrictive: '', less_restrictive: '', newly_automatic: '−' };

function Report({ sim }: { sim: Simulation }) {
  const s = sim.summary;
  return (
    <div className="grid gap-3" data-testid="simulation-report">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            Candidate bundle v{s.bundleVersion} vs. {s.baselineVersion ? `active v${s.baselineVersion}` : 'the mode alone'} — {s.actionsReplayed} actions over {s.windowDays} days
          </CardTitle>
        </CardHeader>
        <CardContent>
          <table className="text-sm" aria-label="What would change">
            <tbody>
              {ORDER.filter((k) => s.counts[k] > 0 || k === 'newly_denied' || k === 'newly_requires_approval').map((k) => (
                <tr key={k}>
                  <th scope="row" className="py-0.5 pr-6 text-left font-normal">
                    {CHANGE_TEXT[k]}:
                  </th>
                  <td className="py-0.5 pr-4 text-right font-mono tabular-nums" data-testid={`count-${k}`}>
                    {SIGN[k]}
                    {s.counts[k]}
                  </td>
                  <td className="py-0.5 text-xs text-muted">
                    {s.topTools[k]?.length ? `mostly ${s.topTools[k]!.map((t) => `${t.toolId} (${t.count})`).join(', ')}` : ''}
                    {k === 'newly_denied' && s.counts[k] > 0 ? <span className="ml-2 text-risk-critical">⚠ review these</span> : null}
                  </td>
                </tr>
              ))}
              <tr>
                <th scope="row" className="py-0.5 pr-6 text-left font-normal">
                  Unchanged:
                </th>
                <td className="py-0.5 pr-4 text-right font-mono tabular-nums">{s.unchanged}</td>
                <td />
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs">
            Estimated additional approvals per week: <span className="font-semibold tabular-nums">{s.approvalsPerWeekDelta > 0 ? `~${s.approvalsPerWeekDelta}` : s.approvalsPerWeekDelta}</span>
            {s.truncated ? ' · the list below shows the first 500 changes' : ''}
          </p>
        </CardContent>
      </Card>
      {ORDER.map((k) => {
        const rows = sim.changes.filter((c) => c.kind === k);
        if (!rows.length) return null;
        return (
          <section key={k} className="grid gap-1" aria-label={CHANGE_TEXT[k]}>
            <h2 className="text-sm font-semibold">
              {CHANGE_TEXT[k]} ({s.counts[k]})
            </h2>
            {rows.map((c) => (
              <details key={c.evaluationId} className="rounded border border-border p-2 text-xs">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <code className="font-semibold">{c.toolId}</code>
                  <span>
                    {DECISION_TEXT[c.from]} → <span className="font-semibold">{DECISION_TEXT[c.to]}</span>
                  </span>
                  <span className="text-muted">{new Date(c.evaluatedAt).toLocaleString()}</span>
                  <Link href={`/runs/${c.runId}`} className="text-primary hover:underline">
                    run
                  </Link>
                </summary>
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  <div>
                    <p className="mb-1 font-semibold">Today</p>
                    <ReasonChain chain={c.fromChain} />
                  </div>
                  <div>
                    <p className="mb-1 font-semibold">With the candidate</p>
                    <ReasonChain chain={c.toChain} />
                  </div>
                </div>
              </details>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function Simulator() {
  const params = useSearchParams();
  const router = useRouter();
  const can = useCan();
  const bundles = useBundles();
  const candidates = (bundles.data ?? []).filter((b) => b.state === 'candidate');
  const [bundleId, setBundleId] = useState(params.get('bundle') ?? '');
  const [days, setDays] = useState(90);
  const [simId, setSimId] = useState<string | null>(params.get('simulation'));
  const stored = useSimulation(simId);
  const run = useAction((id: string) => api.post<Simulation>('/v1/policies/simulate', { bundleId: id, windowDays: days }), [policyKeys.bundles, policyKeys.list]);
  const activate = useAction((id: string) => api.post(`/v1/policies/bundles/${id}/activate`), [policyKeys.bundles, policyKeys.list]);
  const sim = run.data ?? stored.data;
  const chosen = bundleId || candidates[0]?.id || '';
  return (
    <div className="grid gap-4">
      <Link href="/admin/policies" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
        <ArrowLeft aria-hidden className="size-3" /> Policies
      </Link>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Simulate a candidate</CardTitle>
          <CardDescription>What the candidate would have decided for every action actually taken in the window — recomputed from what was recorded, compared with today's rules.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 text-xs">
            Candidate bundle
            <Select aria-label="Candidate bundle" value={chosen} onChange={(e) => setBundleId(e.target.value)}>
              {candidates.map((b) => (
                <option key={b.id} value={b.id}>
                  v{b.version} — {b.policies.length} policies
                </option>
              ))}
            </Select>
          </label>
          <label className="grid gap-1 text-xs">
            Window
            <Select aria-label="Window" value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
              <option value="7">7 days</option>
              <option value="30">30 days</option>
              <option value="90">90 days</option>
            </Select>
          </label>
          <Button
            disabled={!chosen || run.isPending || !can('policy.manage')}
            onClick={async () => {
              const r = await run.mutateAsync(chosen).catch(() => undefined);
              if (!r) return;
              setSimId(r.id);
              router.replace(`/admin/policies/simulate?bundle=${chosen}&simulation=${r.id}`);
            }}
          >
            <FlaskConical aria-hidden /> {run.isPending ? 'Replaying…' : 'Run simulation'}
          </Button>
          {sim && chosen && candidates.some((b) => b.id === chosen) ? (
            <Button
              variant="secondary"
              disabled={activate.isPending}
              onClick={async () => {
                if (await activate.mutateAsync(chosen).catch(() => undefined)) router.push('/admin/policies');
              }}
            >
              <Rocket aria-hidden /> Activate after review
            </Button>
          ) : null}
        </CardContent>
      </Card>
      <ErrorText error={run.error ?? activate.error ?? stored.error} />
      {sim ? <Report sim={sim} /> : !candidates.length ? <p className="text-sm text-muted">No candidate bundle: build one from the policy console first.</p> : null}
    </div>
  );
}

export default function SimulatePage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
      <Simulator />
    </Suspense>
  );
}
