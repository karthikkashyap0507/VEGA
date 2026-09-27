'use client';
import { useQueryClient } from '@tanstack/react-query';
import { FileDiff, FlaskConical, Hammer, Library, Plus, Rocket, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { PolicyEditor } from '@/components/policy/policy-editor';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/me';
import { useAction } from '@/lib/queries';
import { DECISION_TEXT, policyKeys, useBundles, usePolicies, usePolicyVersions, usePreset, useVocabulary, type PolicyRow, type PresetMode } from '@/lib/policy';
import { cn } from '@/lib/utils';

/**
 * POLICY CONSOLE — docs/module5.md §6.1. List (state, version, citation, severity), a YAML editor
 * with live validation and the Rego it compiles to, versions side by side, retire with a date,
 * and the activation flow: build a candidate → SIMULATE (required) → review → activate.
 */

const NEW_POLICY = `id: my-policy
description: What this policy is for, in plain words
citation: The rule it answers to
severity: normal
when:
  all:
    - tool.egress_class: EXTERNAL
    - target.audience: CLIENT
then:
  decision: REQUIRE_APPROVAL
  approver_role: APPROVER
`;

const STATE_TONE = { draft: 'neutral', simulated: 'info', active: 'success', retired: 'neutral' } as const;

type Compiled = { ok: true; policies: Array<{ id: string; decision: string }>; rego: string } | { ok: false; problems: Array<{ path: string; message: string }> };

function useCompile(yaml: string) {
  const [out, setOut] = useState<Compiled | null>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      api.post<Compiled>('/v1/policies/compile', { yaml }).then(setOut, () => setOut(null));
    }, 350);
    return () => clearTimeout(t);
  }, [yaml]);
  return out;
}

function PolicyEditorDialog({ open, onOpenChange, editing }: { open: boolean; onOpenChange: (o: boolean) => void; editing: PolicyRow | null }) {
  const vocab = useVocabulary();
  const [yaml, setYaml] = useState(editing?.specYaml ?? NEW_POLICY);
  useEffect(() => setYaml(editing?.specYaml ?? NEW_POLICY), [editing, open]);
  const compiled = useCompile(yaml);
  const save = useAction(() => (editing ? api.put<PolicyRow>(`/v1/policies/${editing.key}`, { yaml }) : api.post<PolicyRow>('/v1/policies', { yaml })), [policyKeys.list]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl"
        title={editing ? `New version of ${editing.key} (v${editing.version + 1})` : 'New policy'}
        description="YAML only: nobody writes Rego by hand. A saved change is a draft until a simulated bundle containing it is activated."
      >
        <PolicyEditor value={yaml} onChange={setYaml} vocabulary={vocab.data} label="Policy YAML" />
        <div className="grid gap-1 text-xs" aria-live="polite" data-testid="policy-validation">
          {compiled === null ? <span className="text-muted">Checking…</span> : null}
          {compiled && !compiled.ok ? (
            <ul className="grid gap-0.5 text-risk-critical">
              {compiled.problems.map((p) => (
                <li key={`${p.path}:${p.message}`}>
                  <code>{p.path}</code>: {p.message}
                </li>
              ))}
            </ul>
          ) : null}
          {compiled?.ok ? (
            <details>
              <summary className="cursor-pointer text-success">Valid — compiles to Rego (show)</summary>
              <pre className="mt-1 max-h-48 overflow-auto rounded bg-surface-muted p-2 font-mono text-[11px]">{compiled.rego}</pre>
            </details>
          ) : null}
        </div>
        <ErrorText error={save.error} />
        <Button
          disabled={!compiled?.ok || save.isPending}
          onClick={async () => {
            if (await save.mutateAsync(undefined).catch(() => undefined)) onOpenChange(false);
          }}
        >
          {save.isPending ? 'Saving…' : editing ? 'Save new version (draft)' : 'Save draft'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

function VersionsDialog({ policyKey, onClose }: { policyKey: string | null; onClose: () => void }) {
  const versions = usePolicyVersions(policyKey);
  const list = versions.data?.versions ?? [];
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [diff, setDiff] = useState<Array<{ op: 'same' | 'add' | 'del'; text: string }> | null>(null);
  useEffect(() => {
    if (list.length >= 2) {
      setTo(list[0]!.version);
      setFrom(list[1]!.version);
    }
  }, [versions.data]);
  useEffect(() => {
    if (!policyKey || !from || !to || from === to) return setDiff(null);
    api.get<{ lines: Array<{ op: 'same' | 'add' | 'del'; text: string }> }>(`/v1/policies/${policyKey}/diff?from=${from}&to=${to}`).then((d) => setDiff(d.lines), () => setDiff(null));
  }, [policyKey, from, to]);
  return (
    <Dialog open={Boolean(policyKey)} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-w-4xl" title={`Versions of ${policyKey ?? ''}`} description="Earlier versions are never edited: audit history depends on every row.">
        <Table>
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>State</Th>
              <Th>Decision</Th>
              <Th>Created</Th>
              <Th>Compare</Th>
            </tr>
          </thead>
          <tbody>
            {list.map((v) => (
              <tr key={v.version}>
                <Td>v{v.version}</Td>
                <Td>
                  <Badge tone={STATE_TONE[v.state]}>{v.state}</Badge>
                </Td>
                <Td>{DECISION_TEXT[v.decision]}</Td>
                <Td>{new Date(v.createdAt).toLocaleString()}</Td>
                <Td className="flex gap-2 text-xs">
                  <label>
                    <input type="radio" name="from" checked={from === v.version} onChange={() => setFrom(v.version)} /> from
                  </label>
                  <label>
                    <input type="radio" name="to" checked={to === v.version} onChange={() => setTo(v.version)} /> to
                  </label>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {diff ? (
          <div className="grid grid-cols-2 gap-2 font-mono text-[11px]" data-testid="policy-diff" aria-label={`Changes from v${from} to v${to}`}>
            <pre className="overflow-auto rounded bg-surface-muted p-2">
              {diff
                .filter((l) => l.op !== 'add')
                .map((l, i) => (
                  <div key={i} className={cn(l.op === 'del' && 'bg-risk-critical-bg text-risk-critical')}>
                    {l.op === 'del' ? '− ' : '  '}
                    {l.text}
                  </div>
                ))}
            </pre>
            <pre className="overflow-auto rounded bg-surface-muted p-2">
              {diff
                .filter((l) => l.op !== 'del')
                .map((l, i) => (
                  <div key={i} className={cn(l.op === 'add' && 'bg-risk-low-bg text-risk-low')}>
                    {l.op === 'add' ? '+ ' : '  '}
                    {l.text}
                  </div>
                ))}
            </pre>
          </div>
        ) : list.length < 2 ? (
          <p className="text-xs text-muted">Only one version so far.</p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PresetCard({ manage }: { manage: boolean }) {
  const preset = usePreset();
  const set = useAction((mode: PresetMode) => api.put('/v1/policies/preset', { mode }), [policyKeys.preset, policyKeys.list]);
  const text: Record<PresetMode, string> = {
    cautious: 'Everything external needs approval, then a hold; internal changes wait a minute.',
    balanced: 'External sends are held with a window to pull them back; internal undoable steps run.',
    fast: 'Internal actions run; external ones are held briefly. Approval only at HIGH risk and above.',
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Mode</CardTitle>
        <CardDescription>The baseline every action is decided against. Hard gates apply in every mode; no mode permits a recipient taken from untrusted content.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 md:grid-cols-3" role="radiogroup" aria-label="Policy mode">
        {(['cautious', 'balanced', 'fast'] as const).map((m) => {
          const on = preset.data?.mode === m;
          return (
            <button
              key={m}
              role="radio"
              aria-checked={on}
              disabled={!manage || set.isPending}
              onClick={() => set.mutate(m)}
              className={cn('grid gap-1 rounded-md border p-2 text-left text-xs disabled:cursor-not-allowed', on ? 'border-primary bg-surface-muted' : 'border-border')}
            >
              <span className="text-sm font-semibold capitalize">
                {m}
                {on ? ' ✓' : ''}
              </span>
              <span className="text-muted">{text[m]}</span>
            </button>
          );
        })}
        <ErrorText error={set.error} />
      </CardContent>
    </Card>
  );
}

function BundlesCard({ manage }: { manage: boolean }) {
  const bundles = useBundles();
  const qc = useQueryClient();
  const build = useAction(() => api.post('/v1/policies/bundles'), [policyKeys.bundles]);
  const activate = useAction((id: string) => api.post(`/v1/policies/bundles/${id}/activate`), [policyKeys.bundles, policyKeys.list]);
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div className="grid gap-1">
          <CardTitle className="text-sm">Bundles</CardTitle>
          <CardDescription>Build a signed candidate from the current drafts → simulate it against recorded history (required) → activate.</CardDescription>
        </div>
        {manage ? (
          <Button size="sm" onClick={() => build.mutate(undefined)} disabled={build.isPending}>
            <Hammer aria-hidden /> Build candidate
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-2">
        <ErrorText error={build.error ?? activate.error} />
        <Table>
          <thead>
            <tr>
              <Th>Version</Th>
              <Th>State</Th>
              <Th>Policies</Th>
              <Th>Simulation</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {(bundles.data ?? []).map((b) => (
              <tr key={b.id} data-testid={`bundle-v${b.version}`}>
                <Td>v{b.version}</Td>
                <Td>
                  <Badge tone={b.state === 'active' ? 'success' : b.state === 'candidate' ? 'info' : 'neutral'}>{b.state}</Badge>
                </Td>
                <Td className="text-xs">{b.policies.map((p) => `${p.key} v${p.version}`).join(', ') || 'none'}</Td>
                <Td className="text-xs">
                  {b.simulation ? (
                    <Link className="text-primary hover:underline" href={`/admin/policies/simulate?bundle=${b.id}&simulation=${b.simulation.id}`}>
                      {b.simulation.summary.actionsReplayed} actions replayed · {b.simulation.summary.counts.newly_denied} newly denied · {b.simulation.summary.counts.newly_requires_approval} newly need approval
                    </Link>
                  ) : (
                    <span className="text-muted">not simulated</span>
                  )}
                </Td>
                <Td className="flex justify-end gap-2">
                  {b.state === 'candidate' && manage ? (
                    <>
                      <Button size="sm" variant="secondary" asChild>
                        <Link href={`/admin/policies/simulate?bundle=${b.id}`}>
                          <FlaskConical aria-hidden /> Simulate
                        </Link>
                      </Button>
                      <Button
                        size="sm"
                        disabled={!b.simulation || activate.isPending}
                        title={b.simulation ? 'Make this bundle the one OPA enforces' : 'A bundle cannot be activated without a simulation'}
                        onClick={async () => {
                          await activate.mutateAsync(b.id).catch(() => undefined);
                          await qc.invalidateQueries({ queryKey: policyKeys.list });
                        }}
                      >
                        <Rocket aria-hidden /> Activate
                      </Button>
                    </>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {!bundles.data?.length ? <p className="text-xs text-muted">No bundles yet: only the mode above applies.</p> : null}
      </CardContent>
    </Card>
  );
}

export default function PoliciesPage() {
  const can = useCan();
  const manage = can('policy.manage');
  const policies = usePolicies();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<PolicyRow | null>(null);
  const [versionsOf, setVersionsOf] = useState<string | null>(null);
  const retire = useAction((key: string) => api.post(`/v1/policies/${key}/retire`, {}), [policyKeys.list]);
  const pack = useAction(() => api.post<{ added: string[] }>('/v1/policies/packs/professional-services'), [policyKeys.list]);
  if (!can('policy.read')) return <p className="text-sm text-muted">Your role cannot read policies.</p>;
  const items = policies.data?.items ?? [];
  return (
    <div className="grid gap-4">
      <PresetCard manage={manage} />
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-2">
          <div className="grid gap-1">
            <CardTitle className="text-sm">Policies</CardTitle>
            <CardDescription>
              {policies.data?.activeBundle ? `Enforcing bundle v${policies.data.activeBundle.version} (activated ${new Date(policies.data.activeBundle.activatedAt).toLocaleString()}).` : 'No tenant bundle active yet.'} The most restrictive decision always wins.
            </CardDescription>
          </div>
          {manage ? (
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => pack.mutate(undefined)} disabled={pack.isPending} title="Client confidentiality, personal data, health data, credentials, large values, human oversight — each with its citation">
                <Library aria-hidden /> Add professional-services pack
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setEditing(null);
                  setEditorOpen(true);
                }}
              >
                <Plus aria-hidden /> New policy
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-2">
          <ErrorText error={policies.error ?? retire.error ?? pack.error} />
          <Table>
            <thead>
              <tr>
                <Th>Policy</Th>
                <Th>State</Th>
                <Th>Decision</Th>
                <Th>Citation</Th>
                <Th>Severity</Th>
                <Th>Modified</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.key} data-testid={`policy-${p.key}`}>
                  <Td>
                    <div className="grid">
                      <span className="font-mono text-xs font-semibold">{p.key}</span>
                      <span className="text-xs text-muted">{p.description}</span>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge tone={STATE_TONE[p.state]}>
                        {p.state} v{p.version}
                      </Badge>
                      {p.activeVersion && p.activeVersion !== p.version ? <Badge tone="success">active v{p.activeVersion}</Badge> : null}
                      {p.retiring ? <Badge tone="danger">retiring</Badge> : null}
                    </div>
                  </Td>
                  <Td className="text-xs">{DECISION_TEXT[p.decision]}</Td>
                  <Td className="text-xs">{p.citation ?? '—'}</Td>
                  <Td className="text-xs capitalize">{p.severity}</Td>
                  <Td className="text-xs">{new Date(p.createdAt).toLocaleDateString()}</Td>
                  <Td className="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setVersionsOf(p.key)} aria-label={`Versions of ${p.key}`}>
                      <FileDiff aria-hidden />
                    </Button>
                    {manage && p.state !== 'retired' && !p.retiring ? (
                      <>
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => {
                            setEditing(p);
                            setEditorOpen(true);
                          }}
                        >
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => retire.mutate(p.key)} aria-label={`Retire ${p.key}`} title="Retire: out of the next bundle; enforced until it activates">
                          <Trash2 aria-hidden />
                        </Button>
                      </>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!items.length ? <p className="text-xs text-muted">No tenant policies: the mode above decides alone.</p> : null}
        </CardContent>
      </Card>
      <BundlesCard manage={manage} />
      <PolicyEditorDialog open={editorOpen} onOpenChange={setEditorOpen} editing={editing} />
      <VersionsDialog policyKey={versionsOf} onClose={() => setVersionsOf(null)} />
    </div>
  );
}
