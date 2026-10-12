'use client';
import { useQueryClient } from '@tanstack/react-query';
import { BrainCircuit, Download, Pin, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { CLASS_LABEL, kKeys, knowledgeActions, useConflicts, useMemories, type Memory, type MemoryClass } from '@/lib/knowledge';
import { useMe } from '@/lib/me';

/**
 * THE MEMORY MANAGER — docs/module9.md §8.1. Grouped by class; each entry shows content, how and
 * when it was learned, which run created it, source taint, confidence, and last used. Conflicts
 * are resolved inline, with both provenance chains shown — never auto-resolved.
 */

function provenanceText(m: Pick<Memory, 'provenance' | 'createdFromRun' | 'userEdited'>): string {
  if (m.userEdited) return 'edited by you';
  if (m.provenance.via === 'user') return 'you told it this';
  if (m.provenance.via === 'run') return m.createdFromRun ? `learned from a run` : 'learned automatically';
  return 'recorded automatically';
}

function MemoryRow({ m, onChanged }: { m: Memory; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(m.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const confidence = Math.round(Number(m.confidence) * 100);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="grid gap-1.5 rounded-md border border-border p-3" data-testid="memory-row">
      {editing ? (
        <div className="grid gap-2">
          <textarea
            className="min-h-16 w-full rounded-md border border-border bg-surface p-2 text-sm"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            maxLength={2000}
          />
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !content.trim()} onClick={() => run(async () => { await knowledgeActions.updateMemory(m.id, { content }); setEditing(false); })}>
              Save
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setContent(m.content); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm">{m.content}</p>
      )}
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <span>{provenanceText(m)}</span>
        <span>· {new Date(m.validFrom).toLocaleDateString()}</span>
        <span>· confidence {confidence}%</span>
        <Badge tone={m.sourceTaint === 'TRUSTED' ? 'success' : 'info'}>{m.sourceTaint}</Badge>
        {m.stale ? <Badge tone="danger">stale — may be out of date</Badge> : null}
        {m.pinned ? (
          <span className="flex items-center gap-0.5 text-primary">
            <Pin aria-hidden className="size-3" /> pinned
          </span>
        ) : null}
        {m.lastUsedAt ? <span>· last used {new Date(m.lastUsedAt).toLocaleDateString()} ({m.useCount}×)</span> : <span>· never used</span>}
      </p>
      {error ? <ErrorText error={error} /> : null}
      {!editing ? (
        <div className="flex gap-3 text-xs">
          <button type="button" className="text-primary disabled:opacity-50" disabled={busy} onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="text-primary disabled:opacity-50" disabled={busy} onClick={() => run(() => knowledgeActions.updateMemory(m.id, { pinned: !m.pinned }))}>
            {m.pinned ? 'Unpin' : 'Pin'}
          </button>
          {!m.stale ? (
            <button type="button" className="text-primary disabled:opacity-50" disabled={busy} onClick={() => run(() => knowledgeActions.updateMemory(m.id, { stale: true }))}>
              Mark stale
            </button>
          ) : null}
          <button type="button" className="text-danger disabled:opacity-50" disabled={busy} onClick={() => confirm('Delete this memory? This cannot be undone.') && run(() => knowledgeActions.deleteMemory(m.id))}>
            <Trash2 aria-hidden className="mr-0.5 inline size-3" /> Delete
          </button>
        </div>
      ) : null}
    </li>
  );
}

function ConflictCard({ c, onResolved }: { c: ReturnType<typeof useConflicts>['data'] extends (infer T)[] | undefined ? T : never; onResolved: () => void }) {
  const [merged, setMerged] = useState('');
  const [merging, setMerging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const resolve = async (resolution: 'keep_existing' | 'accept_new' | 'merge' | 'both_valid') => {
    setBusy(true);
    setError(null);
    try {
      await knowledgeActions.resolve(c.id, resolution, resolution === 'merge' ? merged : undefined);
      onResolved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card data-testid="memory-conflict">
      <CardHeader>
        <CardTitle className="text-sm">A contradiction — which is right?</CardTitle>
        <CardDescription>You previously said: “{c.existing.content}”. A recent one suggests: “{c.proposed.content}”.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        <p className="text-xs text-muted">
          Existing: {c.existing.userEdited ? 'edited by you' : c.existing.provenance.via === 'run' ? 'learned from a run' : 'told by you'} · New: {c.proposed.provenance.via === 'run' ? 'learned from a run' : 'told by you'} ({c.proposed.sourceTaint})
        </p>
        {error ? <ErrorText error={error} /> : null}
        {merging ? (
          <div className="grid gap-2">
            <textarea className="min-h-16 w-full rounded-md border border-border bg-surface p-2 text-sm" placeholder="Say it in your own words…" value={merged} onChange={(e) => setMerged(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" disabled={busy || !merged.trim()} onClick={() => resolve('merge')}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setMerging(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => resolve('keep_existing')}>
              Keep the old one
            </Button>
            <Button size="sm" disabled={busy} onClick={() => resolve('accept_new')}>
              Take the new one
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => setMerging(true)}>
              Merge, in my words
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => resolve('both_valid')}>
              Keep both
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function MemorySettingsPage() {
  const me = useMe();
  const qc = useQueryClient();
  const memories = useMemories();
  const conflicts = useConflicts();
  const [cls, setCls] = useState<MemoryClass | ''>('');
  const [content, setContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: kKeys.memories() });
    void qc.invalidateQueries({ queryKey: kKeys.conflicts() });
  };

  const grouped = useMemo(() => {
    const by = new Map<MemoryClass, Memory[]>();
    for (const m of memories.data ?? []) {
      if (!by.has(m.class)) by.set(m.class, []);
      by.get(m.class)!.push(m);
    }
    return by;
  }, [memories.data]);

  async function create() {
    if (!cls || !content.trim()) return;
    setCreating(true);
    setCreateError(null);
    try {
      await knowledgeActions.createMemory({ class: cls, content: content.trim() });
      setContent('');
      refresh();
    } catch (e) {
      setCreateError(e);
    } finally {
      setCreating(false);
    }
  }

  async function exportMemories() {
    const out = await knowledgeActions.exportMemories();
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `memory-export-${me.user.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (memories.error) return <ErrorText error={memories.error} />;

  return (
    <div className="mx-auto grid max-w-3xl gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold">What it remembers</h1>
          <p className="text-sm text-muted">Preferences, working context, task history, organization knowledge and style — visible, editable, deletable, and yours to export.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={exportMemories}>
          <Download /> Export
        </Button>
      </header>

      {conflicts.data?.length ? (
        <div className="grid gap-3">
          {conflicts.data.map((c) => (
            <ConflictCard key={c.id} c={c} onResolved={refresh} />
          ))}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Tell it something</CardTitle>
          <CardDescription>Anything you say here is trusted by definition.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
          <Field id="mem-class" label="Class">
            <Select id="mem-class" value={cls} onChange={(e) => setCls(e.target.value as MemoryClass)}>
              <option value="">Choose…</option>
              <option value="preference">Preference</option>
              <option value="long_term_style">Style</option>
            </Select>
          </Field>
          <Field id="mem-content" label="Content">
            <input
              id="mem-content"
              className="h-8 w-full rounded-md border border-border bg-surface px-2.5 text-sm"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={2000}
              placeholder="e.g. Prefers meetings in the morning"
            />
          </Field>
          <Button size="sm" disabled={creating || !cls || !content.trim()} onClick={create}>
            Add
          </Button>
          {createError ? (
            <div className="sm:col-span-3">
              <ErrorText error={createError} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {!memories.data?.length ? (
        <EmptyState icon={BrainCircuit} title="Nothing remembered yet" module="Module 9" description="As agents run for you, what they learn (with your consent, and only from trusted sources) appears here, grouped by class.">
          Nothing to show
        </EmptyState>
      ) : (
        (Object.keys(CLASS_LABEL) as MemoryClass[]).map((c) => {
          const rows = grouped.get(c);
          if (!rows?.length) return null;
          return (
            <Card key={c}>
              <CardHeader>
                <CardTitle className="text-sm">{CLASS_LABEL[c]}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2">
                  {rows.map((m) => (
                    <MemoryRow key={m.id} m={m} onChanged={refresh} />
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}
