'use client';
import { useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Keyboard } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { DecisionPacket, type PacketHandle } from '@/components/approvals/decision-packet';
import { Delegations } from '@/components/approvals/delegations';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RiskBadge, RISK_TIERS, type RiskTier } from '@/components/ui/risk-badge';
import { Select } from '@/components/ui/select';
import { approvalActions, approvalKeys, countdown, useBrief, useQueue, type PacketView, type QueueItem } from '@/lib/approvals';
import { cn } from '@/lib/utils';

/**
 * APPROVAL INBOX — docs/module8.md §5.3, §6.1. A queue, keyboard-first:
 *
 *   j / k   next / previous        a   approve        r   reject (with a reason)
 *   e       edit & approve         v   open / close the evidence      ?   this help
 *
 * Bulk actions only on HOMOGENEOUS groups (same tool, risk tier and reach): ticking an item
 * limits the rest of the selection to its group. Bulk-approving different kinds of action is how
 * rubber-stamping starts; the server refuses it too.
 */

function Inbox() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const [tier, setTier] = useState('');
  const queue = useQueue(tier ? { tier } : {});
  const brief = useBrief();
  const items = queue.data?.items ?? [];
  const [index, setIndex] = useState(0);
  const [openId, setOpenId] = useState<string | null>(params.get('open'));
  const [view, setView] = useState<PacketView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [help, setHelp] = useState(false);
  const packet = useRef<PacketHandle>(null);
  const current: QueueItem | undefined = openId ? items.find((i) => i.id === openId) : items[index];

  // Opening an item fetches its packet: that fetch IS the server's "they looked".
  useEffect(() => {
    if (!current) {
      setView(null);
      return;
    }
    let live = true;
    setError(null);
    approvalActions
      .packet(current.id)
      .then((v) => live && setView(v))
      .catch((e) => live && setError(e));
    return () => {
      live = false;
    };
  }, [current?.id]);

  const refresh = useCallback(async () => {
    setOpenId(null);
    setView(null);
    setSelected(new Map());
    await qc.invalidateQueries({ queryKey: ['approvals'] });
    await qc.invalidateQueries({ queryKey: approvalKeys.brief() });
  }, [qc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
      if (e.key === 'j') setIndex((i) => (setOpenId(null), Math.min(items.length - 1, i + 1)));
      else if (e.key === 'k') setIndex((i) => (setOpenId(null), Math.max(0, i - 1)));
      else if (e.key === 'a') packet.current?.approve();
      else if (e.key === 'r') packet.current?.reject();
      else if (e.key === 'e') packet.current?.edit();
      else if (e.key === 'v') packet.current?.toggleEvidence();
      else if (e.key === '?') setHelp((h) => !h);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items.length]);

  const group = selected.size ? items.find((i) => i.id === [...selected.keys()][0])?.group : undefined;
  const toggle = async (item: QueueItem) => {
    const next = new Map(selected);
    if (next.has(item.id)) next.delete(item.id);
    else {
      // Each selected item's packet is fetched (and so seen) before it can be decided in bulk.
      const v = await approvalActions.packet(item.id);
      next.set(item.id, v.digest);
    }
    setSelected(next);
  };
  const bulk = async (decision: 'approve' | 'reject') => {
    try {
      await approvalActions.bulk([...selected].map(([id, packetDigest]) => ({ id, packetDigest })), decision);
      await refresh();
    } catch (e) {
      setError(e);
    }
  };

  if (queue.error) return <ErrorText error={queue.error} />;
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="grid gap-1">
          <h1 className="text-lg font-semibold">Approvals</h1>
          <p className="text-sm text-muted">What needs a person. Read the packet; open the evidence; decide. Nothing waits forever — each says what happens if you do nothing.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select aria-label="Risk tier" value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">All tiers</option>
            {RISK_TIERS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <Button variant="ghost" size="sm" onClick={() => setHelp((h) => !h)} aria-expanded={help}>
            <Keyboard /> Keys
          </Button>
        </div>
      </header>
      <Delegations />
      {help ? (
        <p className="rounded bg-surface-muted px-3 py-2 text-xs" role="note">
          <kbd>j</kbd>/<kbd>k</kbd> next/previous · <kbd>a</kbd> approve · <kbd>r</kbd> reject · <kbd>e</kbd> edit &amp; approve · <kbd>v</kbd> evidence · <kbd>?</kbd> help
        </p>
      ) : null}

      {!items.length && !queue.isLoading ? (
        <section className="grid justify-items-center gap-2 rounded-lg border border-dashed border-border bg-surface p-10 text-center" data-testid="inbox-empty">
          <ClipboardCheck aria-hidden className="size-8 text-muted" />
          <p className="text-sm font-medium">Nothing needs you right now</p>
          <p className="text-sm text-muted">{brief.data ? `${brief.data.ranAutonomously} action${brief.data.ranAutonomously === 1 ? '' : 's'} ran autonomously today.` : ''}</p>
        </section>
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(16rem,22rem)_1fr]">
          <div className="grid content-start gap-2">
            {selected.size ? (
              <div className="flex items-center gap-2 rounded bg-surface-muted px-2 py-1.5 text-xs" data-testid="bulk-bar">
                {selected.size} of the same kind ·
                <Button size="sm" onClick={() => void bulk('approve')}>
                  Approve all
                </Button>
                <Button size="sm" variant="secondary" onClick={() => void bulk('reject')}>
                  Reject all
                </Button>
              </div>
            ) : null}
            <ul className="grid gap-1" role="listbox" aria-label="Approval queue" data-testid="approval-queue">
              {items.map((i, n) => {
                const active = current?.id === i.id;
                const otherGroup = group !== undefined && group !== i.group;
                return (
                  <li key={i.id} role="option" aria-selected={active} className={cn('flex items-start gap-2 rounded-md border px-2 py-2', active ? 'border-primary bg-surface' : 'border-border bg-surface/60')}>
                    {i.approvalsRequired === 1 ? (
                      <input type="checkbox" className="mt-1" aria-label={`Select ${i.title} for a bulk decision`} checked={selected.has(i.id)} disabled={otherGroup} title={otherGroup ? 'Bulk decisions are only for the same kind of action' : undefined} onChange={() => void toggle(i)} />
                    ) : null}
                    <button type="button" className="grid flex-1 gap-0.5 text-left" onClick={() => (setOpenId(i.id), setIndex(n))}>
                      <span className="text-sm font-medium">{i.title}</span>
                      <span className="flex flex-wrap items-center gap-1 text-xs text-muted">
                        {i.riskTier ? <RiskBadge tier={i.riskTier as RiskTier} /> : null}
                        {i.urgency === 'urgent' ? <Badge tone="danger">urgent</Badge> : null}
                        <span>{countdown(i.expiresAt)} left</span>
                        <span>· {i.requesterName ?? 'requester'}</span>
                        {i.onBehalfOf ? <span>· on behalf (delegated)</span> : null}
                        {i.escalationLevel ? <span>· escalated</span> : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            {error ? <ErrorText error={error} /> : null}
            {view ? (
              <DecisionPacket
                ref={packet}
                view={view}
                onDecide={async (decision, extra) => {
                  await approvalActions.decide(view.id, { decision, packetDigest: view.digest, ...extra });
                  await refresh();
                }}
              />
            ) : current ? (
              <p className="text-sm text-muted">Loading the packet…</p>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense>
      <Inbox />
    </Suspense>
  );
}
