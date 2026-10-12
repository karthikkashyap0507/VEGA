'use client';
import { AlertTriangle, Check, ChevronDown, ChevronRight, HelpCircle, PenLine, X } from 'lucide-react';
import Link from 'next/link';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { ProvenanceChip } from '@/components/provenance/taint';
import { Button } from '@/components/ui/button';
import { CheckList } from '@/components/verification/verification-panel';
import { RiskBadge, type RiskTier } from '@/components/ui/risk-badge';
import { approvalActions, countdown, type PacketView } from '@/lib/approvals';
import { cn } from '@/lib/utils';

/**
 * THE DECISION PACKET — docs/module8.md §5.1, §6.2. One screen: WHAT will happen (the simulated
 * effect, not a plan), WHY, what is unsupported or untrusted, the risk, the policy, and what
 * happens if you do nothing. It renders exactly the packet the server stored and hashed — the
 * digest your decision names — so what you saw is what the receipt proves you saw.
 *
 * The evidence is one tap away, and opening it is measured (§6.2): the time it stays open is
 * sent when it closes. The recommended action is the focused one.
 */

export interface PacketHandle {
  approve(): void;
  reject(): void;
  edit(): void;
  toggleEvidence(): void;
}

type Decide = (decision: 'approve' | 'approve_with_edits' | 'reject', extra: { reason?: string; edits?: Record<string, unknown> }) => Promise<unknown>;

function fieldText(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(', ');
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

export const DecisionPacket = forwardRef<PacketHandle, { view: PacketView; onDecide: Decide; surface?: 'web' | 'mobile'; compact?: boolean; approveLabel?: string }>(function DecisionPacket({ view, onDecide, surface = 'web', compact = false, approveLabel }, ref) {
  const p = view.packet;
  const [evidence, setEvidence] = useState(false);
  const opened = useRef<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState(false);
  const [asking, setAsking] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [, tick] = useState(0);
  const recommended = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => recommended.current?.focus(), [view.id]);

  const toggleEvidence = () => {
    if (!evidence) {
      opened.current = Date.now();
      setEvidence(true);
    } else {
      const dwell = opened.current ? Date.now() - opened.current : null;
      opened.current = null;
      setEvidence(false);
      void approvalActions.evidence(view.id, dwell, surface).catch(() => undefined);
    }
  };
  // Leaving with the evidence open still counts what was read.
  useEffect(
    () => () => {
      if (opened.current) void approvalActions.evidence(view.id, Date.now() - opened.current, surface).catch(() => undefined);
    },
    [view.id, surface],
  );

  const act = async (decision: 'approve' | 'approve_with_edits' | 'reject', extra: { reason?: string; edits?: Record<string, unknown> } = {}) => {
    setBusy(true);
    setError(null);
    try {
      if (opened.current) toggleEvidence();
      await onDecide(decision, extra);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const submitEdits = () => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(edits)) {
      const before = p.evidence.content[k];
      out[k] = Array.isArray(before) ? v.split(',').map((s) => s.trim()).filter(Boolean) : v;
    }
    return act('approve_with_edits', { edits: out });
  };

  useImperativeHandle(ref, () => ({
    approve: () => void act('approve'),
    reject: () => setRejecting(true),
    edit: () => setEditing(true),
    toggleEvidence,
  }));

  const untrusted = p.evidence.untrusted_fields.length;
  const editable = Object.entries(p.evidence.content).filter(([, v]) => typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string')));

  return (
    <article className="grid gap-3 rounded-lg border border-border bg-surface p-4" data-testid="decision-packet" data-digest={view.digest} aria-label={`Decision: ${p.title}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-base font-semibold">{p.title}</h2>
        <div className="flex items-center gap-2">
          {p.risk.tier ? <RiskBadge tier={p.risk.tier as RiskTier} /> : null}
          {p.risk.score !== null ? <span className="text-xs tabular-nums text-muted">{p.risk.score}</span> : null}
        </div>
      </header>

      <section aria-label="What will happen" className="grid gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">What</h3>
        <p className="text-sm">{p.what.summary}</p>
        {p.what.effects.length ? (
          <ul className="flex flex-wrap gap-1 text-xs">
            {p.what.effects.map((e) => (
              <li key={`${e.kind}:${e.value}`} className="rounded bg-surface-muted px-1.5 py-0.5">
                {e.kind === 'recipient' ? '→ ' : ''}
                {e.value}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-muted">
          {p.what.reversibility} · {p.what.reversibility_text}
          {p.what.hold_window_ms ? ` · held ${Math.round(p.what.hold_window_ms / 60_000)} min after approval, revocable` : ''}
        </p>
      </section>

      <section aria-label="Why" className="grid gap-1">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Why</h3>
        <p className="text-sm">{p.why.reasoning}</p>
        {!compact ? <p className="text-xs text-muted">{p.why.objective} · {p.why.trigger}</p> : null}
      </section>

      {untrusted || p.evidence.unsupported_claims.length ? (
        <ul className="grid gap-1 text-xs" aria-label="Warnings">
          {untrusted ? (
            <li className="flex items-center gap-1 text-risk-high">
              <AlertTriangle aria-hidden className="size-3.5" /> Content derived from outside sources ({p.evidence.untrusted_fields.join(', ')})
            </li>
          ) : null}
          {p.evidence.unsupported_claims.map((c) => (
            <li key={c.text} className="flex items-center gap-1 text-risk-high">
              <AlertTriangle aria-hidden className="size-3.5" /> “{c.text}” — {c.reason}
            </li>
          ))}
        </ul>
      ) : null}

      {p.verification ? (
        <section aria-label="Verification" className="grid gap-1" data-testid="packet-verification">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Verification</h3>
          <CheckList checks={p.verification.checks} />
        </section>
      ) : null}

      <section aria-label="Evidence">
        <button type="button" className="flex items-center gap-1 text-sm text-primary" onClick={toggleEvidence} aria-expanded={evidence} data-testid="evidence-toggle">
          {evidence ? <ChevronDown aria-hidden className="size-4" /> : <ChevronRight aria-hidden className="size-4" />} Evidence: exactly what will be sent, and where it came from
        </button>
        {evidence ? (
          <div className="mt-2 grid gap-2 rounded bg-surface-muted p-3 text-xs" data-testid="evidence-drawer">
            <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1">
              {Object.entries(p.evidence.content).map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className={cn('text-muted', p.evidence.untrusted_fields.includes(k) && 'text-risk-high')}>{k}</dt>
                  <dd className="whitespace-pre-wrap break-words">{fieldText(v)}</dd>
                </div>
              ))}
            </dl>
            {p.evidence.sources.length ? (
              <div className="flex flex-wrap gap-1">
                {p.evidence.sources.map((s) => (
                  <ProvenanceChip key={s.id} taint={s.taint as 'TRUSTED' | 'ORG' | 'UNTRUSTED'} sourceIds={[s.id]} label={`${s.id} → ${s.fields.join(', ')}`} />
                ))}
              </div>
            ) : null}
            <Link className="text-primary hover:underline" href={p.evidence.provenance_ref}>
              Provenance graph
            </Link>
          </div>
        ) : null}
      </section>

      <p className="text-xs">
        <span className="font-semibold">Policy</span> {p.policy.id ?? p.policy.decision}
        {p.policy.citation ? ` · ${p.policy.citation}` : ''}
        {view.approvalsRequired > 1 ? ` · ${view.approvals} of ${view.approvalsRequired} approvals${p.routing.separation_of_duties ? ', not by the requester' : ''}` : ''}
      </p>
      <p className="rounded bg-surface-muted px-3 py-2 text-xs" data-testid="if-nothing">
        If you do nothing by {new Date(p.if_you_do_nothing.at).toLocaleTimeString()} ({countdown(p.if_you_do_nothing.at)} left) → {p.if_you_do_nothing.outcome}
      </p>

      {editing ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submitEdits();
          }}
        >
          <p className="text-xs text-muted">Edit, then approve. The edited action is decided again: if it becomes riskier, or reaches someone new, it needs approving again.</p>
          {editable.map(([k, v]) => (
            <label key={k} className="grid gap-1 text-xs">
              <span className="font-medium">{k}</span>
              <textarea className="min-h-16 rounded-md border border-border bg-surface p-2 text-sm" defaultValue={fieldText(v)} onChange={(e) => setEdits({ ...edits, [k]: e.target.value })} aria-label={`Edit ${k}`} />
            </label>
          ))}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !Object.keys(edits).length}>
              <Check /> Approve with edits
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : rejecting || asking ? (
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (rejecting) void act('reject', text.trim() ? { reason: text.trim() } : {});
            else
              void approvalActions
                .question(view.id, text.trim())
                .then(() => setAsking(false))
                .catch(setError);
          }}
        >
          <label className="grid gap-1 text-xs">
            <span className="font-medium">{rejecting ? 'Why not? (optional — it improves the policies)' : 'Your question for the requester'}</span>
            <textarea className="min-h-16 rounded-md border border-border bg-surface p-2 text-sm" value={text} onChange={(e) => setText(e.target.value)} autoFocus aria-label={rejecting ? 'Reason' : 'Question'} />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant={rejecting ? 'danger' : 'primary'} disabled={busy || (asking && text.trim().length < 3)}>
              {rejecting ? 'Reject' : 'Ask (pauses the expiry once)'}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => (setRejecting(false), setAsking(false))}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Decide">
          <Button ref={p.recommended === 'approve' ? recommended : undefined} onClick={() => void act('approve')} disabled={busy} data-testid="approve">
            <Check /> {approveLabel ?? 'Approve'}
          </Button>
          {!compact ? (
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>
              <PenLine /> Edit & approve
            </Button>
          ) : null}
          <Button ref={p.recommended === 'reject' ? recommended : undefined} variant="secondary" onClick={() => setRejecting(true)} disabled={busy} data-testid="reject">
            <X /> Reject
          </Button>
          {!compact ? (
            <Button variant="ghost" onClick={() => setAsking(true)} disabled={busy}>
              <HelpCircle /> Ask
            </Button>
          ) : null}
        </div>
      )}
      {error ? <ErrorText error={error} /> : null}
    </article>
  );
});
