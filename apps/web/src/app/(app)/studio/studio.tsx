'use client';
import { useQueryClient } from '@tanstack/react-query';
import { FlaskConical, KeyRound, Plus, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { AgentSpec } from '@vega/contracts';
import { ReversibilityBadge, type Reversibility } from '@/components/connectors/reversibility-badge';
import { ErrorText } from '@/components/error-text';
import { ProvenanceChip } from '@/components/provenance/taint';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAgents, useTools } from '@/lib/queries';
import { runKeys, useAgentSpec } from '@/lib/runs';

/**
 * AGENT STUDIO v1 — docs/module4.md §6.3. What an agent is for (its objective template), what it
 * may touch (tools, from their declarations), when it runs (manual, schedule, webhook), its
 * limits and escalation defaults. Autonomy is shown as SHADOW and cannot be changed: Module 10
 * earns it; a control the system cannot yet honour is not offered.
 */

type Schedule = { kind: 'schedule'; cron: string; tz: string };

interface TestResult {
  objective: { entities: Array<{ binding: string; raw: string; name?: string; email?: string; resolvedId: string }>; ambiguities: Array<{ raw: string; candidates: unknown[] }> };
  plan:
    | { ok: true; text: string; rows: Array<{ dslNodeId: string | null; toolId: string | null; plannedReversibility: string | null; plannedDecision: string | null; plannedTaint: string | null }>; blocking: Array<{ raw: string }>; assumptions: unknown[]; source: string; attempts: number }
    | { ok: false; reason: string };
  dryRun: { status: string; emits?: Array<{ data: unknown; taint: 'TRUSTED' | 'ORG' | 'UNTRUSTED'; sourceIds: string[] }>; calls?: Array<{ toolId: string; gate: string; executed: boolean }>; error?: string } | null;
}

export function Studio() {
  const qc = useQueryClient();
  const agents = useAgents();
  const usable = (agents.data ?? []).filter((a) => a.status !== 'archived');
  const [agentId, setAgentId] = useState<string>('');
  useEffect(() => {
    if (!agentId && usable[0]) setAgentId(usable[0].id);
  }, [usable, agentId]);
  const spec = useAgentSpec(agentId || undefined);
  const tools = useTools();
  const [draft, setDraft] = useState<AgentSpec | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [secret, setSecret] = useState<{ secret: string; path: string } | null>(null);
  const [objective, setObjective] = useState('');
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (spec.data) setDraft(spec.data.spec);
    setSaved(null);
    setSecret(null);
    setTest(null);
  }, [spec.data]);

  const byKind = useMemo(() => {
    const m = new Map<string, NonNullable<typeof tools.data>>();
    for (const t of tools.data ?? []) m.set(t.connectorKind, [...(m.get(t.connectorKind) ?? []), t]);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools.data]);

  if (agents.isSuccess && !usable.length) {
    return (
      <Card>
        <CardContent className="grid justify-items-center gap-2 p-8 text-center">
          <p className="font-medium">No agents yet</p>
          <p className="text-sm text-muted">Agents are principals with their own identity; create one in Admin, then give it a spec here.</p>
          <Button asChild size="sm" variant="secondary">
            <Link href="/admin/agents">Create an agent</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (!draft) return <p className="text-sm text-muted">Loading…</p>;

  const set = <K extends keyof AgentSpec>(k: K, v: AgentSpec[K]) => setDraft({ ...draft, [k]: v });
  const toggleTool = (id: string, kind: string, on: boolean) => {
    const allowedTools = on ? [...new Set([...draft.allowedTools, id])] : draft.allowedTools.filter((t) => t !== id);
    const kinds = new Set((tools.data ?? []).filter((t) => allowedTools.includes(t.toolId)).map((t) => t.connectorKind));
    setDraft({ ...draft, allowedTools, allowedConnectors: [...kinds].sort() });
    void kind;
  };
  const schedules = draft.triggers.filter((t): t is Schedule => t.kind === 'schedule');
  const webhook = draft.triggers.some((t) => t.kind === 'webhook');
  const setTriggers = (s: Schedule[], hook: boolean) => set('triggers', [{ kind: 'manual' }, ...s, ...(hook ? [{ kind: 'webhook' as const }] : [])]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.put<{ version: number }>(`/v1/agents/${agentId}/spec`, draft);
      setSaved(`Saved as version ${r.version}. New runs use it; running ones keep the version they started with.`);
      await qc.invalidateQueries({ queryKey: runKeys.spec(agentId) });
      await qc.invalidateQueries({ queryKey: ['agents'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function runTest() {
    setBusy(true);
    setError(null);
    setTest(null);
    try {
      setTest(await api.post<TestResult>(`/v1/agents/${agentId}/test`, { objective }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-xs">
          <span className="text-muted">Agent</span>
          <select className="h-8 rounded-md border border-border bg-surface px-2 text-sm" value={agentId} onChange={(e) => setAgentId(e.target.value)} aria-label="Agent">
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.status})
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-muted">Version {spec.data?.version ?? '—'}</span>
        <Badge tone="neutral" title="Autonomy is earned per action type from Module 10; until then every agent runs in shadow/supervised mode.">
          Autonomy: SHADOW (read-only)
        </Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="grid gap-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Purpose</CardTitle>
                <CardDescription>The objective scheduled and webhook runs start from. Chat runs start from what the user types.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <textarea
                aria-label="Objective template"
                className="min-h-[4rem] w-full rounded-md border border-border bg-surface px-3 py-2 text-sm"
                value={draft.objectiveTemplate}
                onChange={(e) => set('objectiveTemplate', e.target.value)}
                maxLength={4000}
                placeholder="e.g. Summarize my emails about &quot;renewal&quot; every weekday morning"
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Tools</CardTitle>
                <CardDescription>Only these may be called. The list is enforced again at every call, and the run credential is scoped to it.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              {byKind.map(([kind, list]) => (
                <fieldset key={kind} className="grid gap-1">
                  <legend className="text-xs font-semibold uppercase tracking-wide text-muted">{kind}</legend>
                  {list.map((t) => (
                    <label key={t.toolId} className="flex flex-wrap items-center gap-2 text-sm">
                      <input type="checkbox" checked={draft.allowedTools.includes(t.toolId)} onChange={(e) => toggleTool(t.toolId, kind, e.target.checked)} aria-label={t.toolId} />
                      <code>{t.toolId}</code>
                      <ReversibilityBadge value={t.reversibility as Reversibility} />
                      <span className="text-xs text-muted">{t.title}</span>
                    </label>
                  ))}
                </fieldset>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Triggers</CardTitle>
                <CardDescription>Manual (chat, API) is always on. A webhook’s body is untrusted input, never an instruction.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-2">
              {schedules.map((s, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Field id={`cron-${i}`} label="Schedule (cron)">
                    <Input id={`cron-${i}`} value={s.cron} onChange={(e) => setTriggers(schedules.map((x, j) => (j === i ? { ...x, cron: e.target.value } : x)), webhook)} />
                  </Field>
                  <Field id={`tz-${i}`} label="Time zone">
                    <Input id={`tz-${i}`} value={s.tz} onChange={(e) => setTriggers(schedules.map((x, j) => (j === i ? { ...x, tz: e.target.value } : x)), webhook)} />
                  </Field>
                  <Button size="sm" variant="ghost" aria-label="Remove schedule" onClick={() => setTriggers(schedules.filter((_, j) => j !== i), webhook)}>
                    <Trash2 aria-hidden />
                  </Button>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setTriggers([...schedules, { kind: 'schedule', cron: '0 8 * * 1-5', tz: 'UTC' }], webhook)}>
                  <Plus aria-hidden /> Add schedule
                </Button>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={webhook} onChange={(e) => setTriggers(schedules, e.target.checked)} /> Webhook trigger
                </label>
                {webhook ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={async () => {
                      try {
                        setSecret(await api.post<{ secret: string; path: string }>(`/v1/agents/${agentId}/webhook-secret`));
                      } catch (e) {
                        setError(e);
                      }
                    }}
                  >
                    <KeyRound aria-hidden /> {spec.data?.webhookConfigured ? 'Rotate secret' : 'Create secret'}
                  </Button>
                ) : null}
              </div>
              {secret ? (
                <p role="status" className="rounded border border-border bg-surface-muted p-2 text-xs">
                  POST <code>{secret.path}</code> with <code>Authorization: Bearer {secret.secret}</code>. Shown once — store it now.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Limits and escalation</CardTitle>
                <CardDescription>A plan that could exceed a limit is rejected before it runs; a run that reaches one stops.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-3">
              <Field id="max-steps" label="Max tool calls">
                <Input id="max-steps" type="number" min={1} max={500} value={draft.limits.maxSteps} onChange={(e) => set('limits', { ...draft.limits, maxSteps: Number(e.target.value) })} />
              </Field>
              <Field id="max-fanout" label="Max items per map">
                <Input id="max-fanout" type="number" min={1} max={100} value={draft.limits.maxFanout} onChange={(e) => set('limits', { ...draft.limits, maxFanout: Number(e.target.value) })} />
              </Field>
              <Field id="max-cost" label="Max cost (cents)">
                <Input id="max-cost" type="number" min={0} max={100000} value={draft.limits.maxCostCents} onChange={(e) => set('limits', { ...draft.limits, maxCostCents: Number(e.target.value) })} />
              </Field>
              <Field id="approver" label="Approver role">
                <select id="approver" className="h-8 rounded-md border border-border bg-surface px-2 text-sm" value={draft.escalation.approverRole} onChange={(e) => set('escalation', { ...draft.escalation, approverRole: e.target.value })}>
                  {['APPROVER', 'ADMIN', 'OWNER', 'WORKFLOW_OWNER'].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </Field>
              <Field id="expiry" label="Approval expires after" hint="e.g. 30m, 4h, 2d">
                <Input id="expiry" value={draft.escalation.expiry} onChange={(e) => set('escalation', { ...draft.escalation, expiry: e.target.value })} />
              </Field>
              <Field id="fallback" label="On expiry">
                <select id="fallback" className="h-8 rounded-md border border-border bg-surface px-2 text-sm" value={draft.escalation.fallback} onChange={(e) => set('escalation', { ...draft.escalation, fallback: e.target.value as 'AUTO_REJECT' | 'ESCALATE' })}>
                  <option value="AUTO_REJECT">Reject</option>
                  <option value="ESCALATE">Escalate (Module 8)</option>
                </select>
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Fixed plan (optional)</CardTitle>
                <CardDescription>A program in the plan language. Validated like a generated one; used instead of the planner.</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <textarea
                aria-label="Fixed program"
                className="min-h-[6rem] w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs"
                value={draft.program ?? ''}
                onChange={(e) => {
                  const { program: _p, ...rest } = draft;
                  setDraft(e.target.value.trim() ? { ...rest, program: e.target.value } : rest);
                }}
              />
            </CardContent>
          </Card>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => void save()} disabled={busy}>
              <Save aria-hidden /> Save as new version
            </Button>
            {saved ? (
              <p role="status" className="text-sm text-success">
                {saved}
              </p>
            ) : null}
          </div>
          {error ? <ErrorText error={error} /> : null}
        </div>

        <aside className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Test (dry run)</CardTitle>
                <CardDescription>Understands and plans for real; reads run, nothing is sent, shared or changed.</CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-2">
              <textarea aria-label="Test objective" className="min-h-[3rem] w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="Email Peter saying the deck is ready" />
              <Button size="sm" variant="secondary" onClick={() => void runTest()} disabled={busy || !objective.trim()}>
                <FlaskConical aria-hidden /> Dry run
              </Button>
              {test ? (
                <div className="grid gap-2 text-xs" data-testid="studio-test-result">
                  {test.objective.entities.map((e) => (
                    <ProvenanceChip key={e.binding} taint="TRUSTED" sourceIds={[`registry:${e.resolvedId}`]} label={`${e.raw} → ${e.name ?? e.email}`} />
                  ))}
                  {test.plan.ok ? (
                    <>
                      <pre className="overflow-x-auto rounded border border-border bg-surface-muted p-2">{test.plan.text}</pre>
                      {test.plan.blocking.length ? <p className="text-risk-medium">Would ask which “{test.plan.blocking[0]!.raw}” before running.</p> : null}
                      <ul className="grid gap-1">
                        {test.plan.rows.map((r, i) => (
                          <li key={i} className="flex flex-wrap items-center gap-1">
                            <code>{r.toolId}</code>
                            {r.plannedReversibility ? <ReversibilityBadge value={r.plannedReversibility as Reversibility} /> : null}
                            {r.plannedDecision === 'REQUIRE_APPROVAL' ? <Badge tone="info">needs approval</Badge> : null}
                          </li>
                        ))}
                      </ul>
                      {test.dryRun ? <p>Dry run: {test.dryRun.status}{test.dryRun.error ? ` — ${test.dryRun.error}` : ''}</p> : null}
                    </>
                  ) : (
                    <p className="text-risk-critical">{test.plan.reason}</p>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Versions</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-1 text-xs">
                {(spec.data?.versions ?? []).map((v) => (
                  <li key={v.version}>
                    v{v.version} · {new Date(v.createdAt).toLocaleString()}
                  </li>
                ))}
                {!spec.data?.versions.length ? <li className="text-muted">Not saved yet.</li> : null}
              </ul>
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
