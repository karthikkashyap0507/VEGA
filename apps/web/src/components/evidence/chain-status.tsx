'use client';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { evidenceActions, evidenceKeys, shortDigest, useChainHead } from '@/lib/evidence';
import { useCan } from '@/lib/me';
import { cn } from '@/lib/utils';

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 90
    ? `${Math.round(s)} s ago`
    : s < 5400
      ? `${Math.round(s / 60)} min ago`
      : s < 129_600
        ? `${Math.round(s / 3600)} h ago`
        : `${Math.round(s / 86_400)} d ago`;
};

/**
 * VERIFICATION STATUS (docs/module7.md §6.1, §6.5): chain intact, last anchor, entries since.
 * "Green is not decoration here — a customer's compliance officer checks it." So the state is
 * always said in words and an icon, never by colour alone, and "not yet verified" is not green.
 */
export function ChainStatus({ compact = false }: { compact?: boolean }) {
  const qc = useQueryClient();
  const head = useChainHead();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (head.error) return compact ? null : <ErrorText error={head.error} />;
  const h = head.data;
  const v = h?.verification;
  const state = !h ? 'loading' : !h.head ? 'empty' : !v ? 'unverified' : v.ok ? 'intact' : 'broken';
  const Icon = state === 'intact' ? ShieldCheck : state === 'broken' ? ShieldAlert : ShieldQuestion;
  const label = {
    loading: 'Checking the chain…',
    empty: 'No entries yet',
    unverified: 'Not yet verified',
    intact: 'Chain intact',
    broken: 'CHAIN VERIFICATION FAILED',
  }[state];
  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      await evidenceActions.verify();
      await qc.invalidateQueries({ queryKey: evidenceKeys.head() });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label="Evidence chain status"
      data-testid="chain-status"
      className={cn(
        'grid gap-1 rounded-lg border px-3 py-2 text-xs',
        state === 'broken' ? 'border-danger bg-risk-critical-bg' : 'border-border bg-surface',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          aria-hidden
          className={cn(
            'size-4',
            state === 'intact' ? 'text-success' : state === 'broken' ? 'text-danger' : 'text-muted',
          )}
        />
        <span className={cn('font-semibold', state === 'broken' && 'text-danger')}>{label}</span>
        {v ? (
          <span className="text-muted">
            verified {ago(v.checkedAt)} · {v.entries.toLocaleString()} entries
          </span>
        ) : null}
        {!compact && h?.head ? (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={verify} disabled={busy}>
            {busy ? 'Verifying…' : 'Verify now'}
          </Button>
        ) : null}
      </div>
      {h?.head ? (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-muted">
          <span>
            Head: seq {h.head.seq.toLocaleString()}{' '}
            <span className="font-mono">{shortDigest(h.head.entryHash)}</span>
          </span>
          <span>
            {h.lastAnchor
              ? `Last anchor ${ago(h.lastAnchor.anchoredAt)} (${h.lastAnchor.treeSize.toLocaleString()} entries)`
              : 'Not anchored yet'}
          </span>
          <span>{h.entriesSinceAnchor.toLocaleString()} since the last anchor</span>
        </div>
      ) : null}
      {error ? <ErrorText error={error} /> : null}
    </section>
  );
}

/** The persistent indicator for the Action Center (§6.5): shown to whoever may read the chain. */
export function ChainStatusIndicator() {
  const can = useCan();
  return can('audit.read') ? <ChainStatus compact /> : null;
}
