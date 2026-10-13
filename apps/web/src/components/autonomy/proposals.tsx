'use client';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { autonomyActions, autonomyKeys, pct, useProposals, type Proposal } from '@/lib/autonomy';
import { useCan } from '@/lib/me';

/**
 * THE PROPOSAL INBOX — docs/module10.md §5, §15.3. The system reads the override corpus and says
 * what it noticed. A proposal is a read-only artifact: it cites the decisions behind it, and
 * accepting it changes nothing by itself — the change it describes is then made as an ordinary,
 * audited one (authoring a policy, requesting a certification, demoting).
 */

const KIND: Record<Proposal['kind'], { title: string; tone: 'info' | 'danger' | 'neutral' }> = {
  promote: { title: 'Ready to earn more autonomy', tone: 'info' },
  demote: { title: 'Needs a tighter leash', tone: 'danger' },
  new_policy: { title: 'A rule your approvers keep applying by hand', tone: 'neutral' },
};

function headline(p: Proposal): string {
  const e = p.evidenceJson as Record<string, number | string[] | undefined>;
  const subject = `${p.subjectJson.actionType ?? 'an action'}`;
  if (p.kind === 'promote') return `You have approved ${e['approved'] ?? e['decisions']} of ${e['decisions']} ${subject} actions without a single edit or rejection.`;
  if (p.kind === 'demote') return `${e['edits']} of the last ${e['recent']} ${subject} actions were edited before release.`;
  return `${e['edits']} edits to ${p.subjectJson.change?.split(':')[0] ?? 'the same field'} on ${subject}, by ${e['approvers']} approver(s) — the same change each time.`;
}

function nextStep(p: Proposal): { text: string; href?: string } {
  const a = p.proposedChange.action;
  if (a === 'request_certification') return { text: 'Run a certification for this action; promotion still needs the gate and a person’s ratification.', href: '/autonomy' };
  if (a === 'set_tier') return { text: 'Demote this action to Supervised until the edits stop.', href: '/autonomy' };
  return { text: 'Write this as a policy so it is applied every time, and so approvers stop doing it by hand.', href: '/admin/policies' };
}

function ProposalCard({ p }: { p: Proposal }) {
  const qc = useQueryClient();
  const can = useCan();
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<'accepted' | 'dismissed' | null>(null);
  const ids = p.evidenceJson.decisionIds ?? [];
  const decide = async (d: 'accepted' | 'dismissed') => {
    setError(null);
    try {
      await autonomyActions.decideProposal(p.id, d);
      setDone(d);
      await qc.invalidateQueries({ queryKey: ['autonomy'] });
    } catch (e) {
      setError(e);
    }
  };
  const k = KIND[p.kind];
  const step = nextStep(p);
  return (
    <Card data-testid="proposal">
      <CardContent className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={k.tone}>{k.title}</Badge>
          <span className="font-mono text-xs text-muted">{p.subjectJson.actionType}</span>
          <span className="text-xs text-muted">confidence {pct(p.confidence)}</span>
          <span className="ml-auto text-xs text-muted">expires {new Date(p.expiresAt).toLocaleDateString()}</span>
        </div>
        <p className="text-sm">{headline(p)}</p>
        <p className="text-xs text-muted">
          Evidence: {ids.length} decision{ids.length === 1 ? '' : 's'} (kept in the override corpus; every one is linked from the audit explorer by its id).
        </p>
        <p className="text-xs">
          <span className="text-muted">If you accept: </span>
          {step.text}{' '}
          {step.href ? (
            <Link className="text-primary hover:underline" href={step.href}>
              Go there
            </Link>
          ) : null}
        </p>
        {done ? (
          <p className="text-xs text-success">{done === 'accepted' ? 'Accepted — nothing has changed yet; make the change above.' : 'Dismissed. Repeated dismissals stop this kind of suggestion.'}</p>
        ) : can('autonomy.ratify') || can('autonomy.request_promotion') || can('policy.manage') ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => decide('accepted')}>
              Accept
            </Button>
            <Button size="sm" variant="secondary" onClick={() => decide('dismissed')}>
              Dismiss
            </Button>
          </div>
        ) : null}
        {error ? <ErrorText error={error} /> : null}
      </CardContent>
    </Card>
  );
}

export function ProposalInbox() {
  const qc = useQueryClient();
  const can = useCan();
  const open = useProposals('open');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState<string | null>(null);
  const mine = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await autonomyActions.generateProposals();
      setNote(r.created.length ? `${r.created.length} new suggestion${r.created.length > 1 ? 's' : ''}.` : 'Nothing new to suggest from the history so far.');
      await qc.invalidateQueries({ queryKey: autonomyKeys.proposals('open') });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader>
          <div className="grid gap-0.5">
            <CardTitle>What the decisions say</CardTitle>
            <CardDescription>Suggestions mined from what your approvers actually did. Nothing is applied for you.</CardDescription>
          </div>
          {can('policy.manage') || can('autonomy.ratify') || can('autonomy.request_promotion') ? (
            <Button size="sm" variant="secondary" disabled={busy} onClick={mine}>
              Look again now
            </Button>
          ) : null}
        </CardHeader>
        {note || error ? (
          <CardContent>
            {note ? <p className="text-xs text-muted">{note}</p> : null}
            {error ? <ErrorText error={error} /> : null}
          </CardContent>
        ) : null}
      </Card>
      {open.error ? <ErrorText error={open.error} /> : null}
      {(open.data?.items ?? []).map((p) => (
        <ProposalCard key={p.id} p={p} />
      ))}
      {open.data && !open.data.items.length ? <p className="text-sm text-muted">No open suggestions. They appear once there is enough clean, or consistently edited, history.</p> : null}
    </div>
  );
}
