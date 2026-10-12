'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { approvalActions } from '@/lib/approvals';
import { useMe } from '@/lib/me';
import { useUsers } from '@/lib/queries';

interface Delegation {
  id: string;
  fromUser: string;
  toUser: string;
  roleScope: string | null;
  startsAt: string;
  endsAt: string;
  reason: string | null;
  active: boolean;
}

/**
 * AWAY? DELEGATE — docs/module8.md §5.4, §10. Your approvals go to someone else for a while:
 * time-bounded (at most 90 days), never more authority than you hold, recorded. While it lasts
 * they decide on your behalf; when it ends, they cannot.
 */
export function Delegations() {
  const me = useMe();
  const qc = useQueryClient();
  const users = useUsers();
  const list = useQuery({ queryKey: ['delegations'], queryFn: () => api.get<Delegation[]>('/v1/delegations') });
  const [to, setTo] = useState('');
  const [until, setUntil] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const name = (id: string) => users.data?.find((u) => u.id === id)?.displayName ?? users.data?.find((u) => u.id === id)?.email ?? id.slice(0, 8);
  const save = async () => {
    setError(null);
    try {
      await approvalActions.delegate({ toUser: to, endsAt: new Date(`${until}T23:59:59Z`).toISOString(), reason: reason || null });
      setTo('');
      setUntil('');
      setReason('');
      await qc.invalidateQueries({ queryKey: ['delegations'] });
    } catch (e) {
      setError(e);
    }
  };
  return (
    <details className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
      <summary className="cursor-pointer font-medium">Away? Delegate your approvals</summary>
      <div className="mt-3 grid gap-3">
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_auto] sm:items-end">
          <div className="grid gap-1">
            <Label htmlFor="d-to">To</Label>
            <Select id="d-to" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose a person</option>
              {(users.data ?? [])
                .filter((u) => u.id !== me.user.id && u.status === 'active')
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName ?? u.email}
                  </option>
                ))}
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="d-until">Until</Label>
            <Input id="d-until" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="d-reason">Why (recorded)</Label>
            <Input id="d-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Out of office" />
          </div>
          <Button size="sm" onClick={() => void save()} disabled={!to || !until}>
            Delegate
          </Button>
        </div>
        {error ? <ErrorText error={error} /> : null}
        <ul className="grid gap-1 text-xs" aria-label="Delegations">
          {(list.data ?? []).map((d) => (
            <li key={d.id} className="flex items-center gap-2">
              <span>
                {name(d.fromUser)} → {name(d.toUser)} until {new Date(d.endsAt).toLocaleDateString()} {d.active ? '(active)' : '(ended)'}
              </span>
              {d.active && d.fromUser === me.user.id ? (
                <Button size="sm" variant="ghost" onClick={() => void approvalActions.endDelegation(d.id).then(() => qc.invalidateQueries({ queryKey: ['delegations'] }))}>
                  End now
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </details>
  );
}
