'use client';
import { AlertTriangle, Check, CircleSlash, X } from 'lucide-react';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { CHECK_LABEL, useFindings, useRetrievals, useRunVerifications } from '@/lib/knowledge';
import { cn } from '@/lib/utils';

/**
 * VERIFICATION RESULTS (docs/module9.md §8.3) — one line per check, in the order they ran, the
 * same panel in the trace and in the approval packet. Shape and color together: an icon AND a
 * word, never color alone.
 */
export function CheckList({ checks }: { checks: Array<{ check: string; outcome: string; detail: string }> }) {
  return (
    <ul className="grid gap-1 text-sm" data-testid="verification-checks">
      {checks.map((c) => {
        const ok = c.outcome === 'PASS';
        const warn = c.outcome === 'WARN' || c.outcome === 'ESCALATE';
        const skip = c.outcome === 'SKIPPED';
        const Icon = ok ? Check : warn ? AlertTriangle : skip ? CircleSlash : X;
        return (
          <li key={c.check} className="grid grid-cols-[1rem_8rem_1fr] items-start gap-2">
            <Icon aria-hidden className={cn('mt-0.5 size-4', ok && 'text-success', warn && 'text-risk-high', skip && 'text-muted', !ok && !warn && !skip && 'text-danger')} />
            <span className="font-medium">
              {CHECK_LABEL[c.check] ?? c.check}
              <span className="sr-only"> — {c.outcome}</span>
            </span>
            <span className={cn('text-muted', !ok && !skip && 'text-foreground')}>{c.detail}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Findings({ id }: { id: string }) {
  const f = useFindings(id);
  if (f.error) return <ErrorText error={f.error} />;
  if (!f.data) return <p className="text-xs text-muted">Loading claims…</p>;
  return (
    <ul className="grid gap-1 text-xs" data-testid="groundedness-findings">
      {f.data.map((x) => (
        <li key={x.id} className="flex flex-wrap items-center gap-2">
          <Badge tone={x.verdict === 'SUPPORTED' ? 'success' : x.severity === 'BLOCK' ? 'danger' : 'neutral'}>{x.verdict.toLowerCase()}</Badge>
          <span>“{x.claimText}”</span>
          <span className="text-muted">
            {x.claimKind}
            {x.field ? ` in ${x.field}` : ''}
            {x.sourceIds.length ? ` · ${x.sourceIds.join(', ')}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Every verification of a run (pre- and post-commit), newest last, claims on demand. */
export function RunVerifications({ runId }: { runId: string }) {
  const v = useRunVerifications(runId);
  const [open, setOpen] = useState<string | null>(null);
  if (v.error) return <ErrorText error={v.error} />;
  if (!v.data) return <p className="text-sm text-muted">Loading verifications…</p>;
  if (!v.data.length) return <p className="text-sm text-muted">No consequential step was verified in this run (reads only, or nothing ran).</p>;
  return (
    <ol className="grid gap-4">
      {v.data.map((x) => (
        <li key={x.id} className="grid gap-2" data-testid="verification">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <span className="font-mono text-xs">{x.toolId}</span>
            <Badge tone={x.outcome === 'PASS' ? 'success' : x.outcome === 'ABORT' || x.outcome === 'COMPENSATE' ? 'danger' : 'neutral'}>{x.outcome}</Badge>
            <span className="text-xs text-muted">
              {x.phase === 'pre_commit' ? 'before it ran' : 'after it ran'} · {new Date(x.createdAt).toLocaleTimeString()}
              {x.durationMs !== null ? ` · ${x.durationMs} ms` : ''}
            </span>
          </p>
          <CheckList checks={x.checksJson} />
          {x.claims ? (
            <div className="grid gap-1">
              <button type="button" className="w-fit text-xs text-primary" onClick={() => setOpen(open === x.id ? null : x.id)} aria-expanded={open === x.id}>
                {x.unsupported} of {x.claims} claims unsupported — {open === x.id ? 'hide' : 'show'}
              </button>
              {open === x.id ? <Findings id={x.id} /> : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * THE RETRIEVAL INSPECTOR (§8.4): what was retrieved for this run, from which documents, at what
 * score — and how many chunks were withheld by permission.
 */
export function RetrievalInspector({ runId }: { runId: string }) {
  const r = useRetrievals(runId);
  if (r.error) return <ErrorText error={r.error} />;
  if (!r.data) return <p className="text-sm text-muted">Loading retrievals…</p>;
  if (!r.data.length) return <p className="text-sm text-muted">Nothing was retrieved from memory or the knowledge base for this run.</p>;
  return (
    <ul className="grid gap-4" data-testid="retrievals">
      {r.data.map((x) => (
        <li key={x.id} className="grid gap-1 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="info">{x.purpose}</Badge>
            <span className="text-xs text-muted">{new Date(x.createdAt).toLocaleString()}</span>
            <span className="text-xs font-semibold" data-testid="acl-filtered">
              {x.aclFiltered} withheld by permission
            </span>
            {x.sensitivityFiltered ? <span className="text-xs text-muted">· {x.sensitivityFiltered} withheld as sensitive</span> : null}
          </p>
          {x.chunks.length ? (
            <ul className="grid gap-0.5 text-xs">
              {x.chunks.map((c) => (
                <li key={c.id}>
                  {c.removed ? (
                    <span className="text-muted">(a passage since deleted)</span>
                  ) : (
                    <>
                      {c.title} <span className="text-muted">› {c.headingPath?.join(' › ')}</span> <Badge>{c.taint}</Badge>
                    </>
                  )}
                  {c.score !== null ? <span className="ml-1 font-mono text-muted">{c.score.toFixed(3)}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {x.memories.length ? (
            <ul className="grid gap-0.5 text-xs">
              {x.memories.map((m) => (
                <li key={m.id}>{m.removed ? <span className="text-muted">(a memory since deleted)</span> : <>Memory ({m.class}): {m.content}</>}</li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
