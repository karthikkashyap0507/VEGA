'use client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { autonomyActions, autonomyKeys, useActivity, useConflicts, useLedger, useLocks, type WriteConflict } from '@/lib/autonomy';
import { useCan } from '@/lib/me';

/**
 * CONTENTION VIEWS — docs/module10.md §10, §15.4: who else is on this account, the active locks,
 * the contact ledger with its cooldowns, and write conflicts waiting for a person. Overrides are
 * audited exceptions: each takes a reason, and the ledger says so.
 */

const when = (iso: string) => new Date(iso).toLocaleString();
const short = (id: string) => id.slice(0, 8);

function Activity() {
  const [input, setInput] = useState('');
  const [key, setKey] = useState('');
  const act = useActivity(key);
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Who else is on this account</CardTitle>
          <CardDescription>Every agent currently acting on a record, what it intends, and who is waiting. Enter a record key such as crm:acct-42.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setKey(input.trim());
          }}
        >
          <Input aria-label="Record key" value={input} onChange={(e) => setInput(e.target.value)} placeholder="system:record-id" className="max-w-xs font-mono" />
          <Button type="submit" size="sm" variant="secondary">
            Look up
          </Button>
        </form>
        {act.error ? <ErrorText error={act.error} /> : null}
        {act.data ? (
          <div className="grid gap-2" data-testid="activity">
            {act.data.holders.length ? (
              <ul className="grid gap-1 text-sm">
                {act.data.holders.map((h) => (
                  <li key={h.lockId} className="flex flex-wrap items-center gap-2 rounded border border-border px-2 py-1.5">
                    <Badge tone="info">{h.mode.replace('_', ' ').toLowerCase()}</Badge>
                    <span>{h.intent}</span>
                    <span className="text-xs text-muted">agent {short(h.agentId)} · run {short(h.runId)} · until {when(h.leaseExpiresAt)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nobody is acting on {act.data.entityKey} right now.</p>
            )}
            {act.data.waiters.length ? (
              <div className="grid gap-1">
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">Waiting</h4>
                <ul className="text-xs">
                  {act.data.waiters.map((w) => (
                    <li key={`${w.runId}-${w.waitingSince}`}>
                      agent {short(w.agentId)} (run {short(w.runId)}) since {when(w.waitingSince)}
                      {w.riskTier ? ` · ${w.riskTier} risk` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Locks() {
  const qc = useQueryClient();
  const can = useCan();
  const locks = useLocks();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const release = async (id: string) => {
    setError(null);
    try {
      await autonomyActions.releaseLock(id, (reasons[id] ?? '').trim());
      await qc.invalidateQueries({ queryKey: autonomyKeys.locks });
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Active locks</CardTitle>
          <CardDescription>Held for the length of a run and released when it ends; a lease frees one that is abandoned. Releasing by hand is an audited override.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {locks.error ? <ErrorText error={locks.error} /> : null}
        <Table data-testid="locks">
          <thead>
            <tr>
              <Th>Record</Th>
              <Th>Mode</Th>
              <Th>Intent</Th>
              <Th>Held by</Th>
              <Th>Lease ends</Th>
              {can('workspaces.manage') ? <Th>Override</Th> : null}
            </tr>
          </thead>
          <tbody>
            {(locks.data?.items ?? []).map((l) => (
              <tr key={l.lockId}>
                <Td className="font-mono text-xs">{l.entityKey}</Td>
                <Td className="text-xs">{l.mode.replace('_', ' ').toLowerCase()}</Td>
                <Td className="text-sm">{l.intent}</Td>
                <Td className="text-xs text-muted">
                  agent {short(l.agentId)} · run {short(l.runId)}
                </Td>
                <Td className="whitespace-nowrap text-xs">{when(l.leaseExpiresAt)}</Td>
                {can('workspaces.manage') ? (
                  <Td>
                    <div className="flex gap-1">
                      <Input aria-label={`Reason to release ${l.entityKey}`} placeholder="Reason" className="w-40" value={reasons[l.lockId] ?? ''} onChange={(e) => setReasons({ ...reasons, [l.lockId]: e.target.value })} />
                      <Button size="sm" variant="danger" disabled={(reasons[l.lockId] ?? '').trim().length < 3} onClick={() => release(l.lockId)}>
                        Release
                      </Button>
                    </div>
                  </Td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </Table>
        {locks.data && !locks.data.items.length ? <p className="p-4 text-sm text-muted">No locks are held.</p> : null}
        {error ? (
          <div className="px-4 pb-3">
            <ErrorText error={error} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Ledger() {
  const can = useCan();
  const [identity, setIdentity] = useState('');
  const [applied, setApplied] = useState('');
  const allowed = can('audit.read') || can('agents.manage');
  const ledger = useLedger(applied, allowed);
  const qc = useQueryClient();
  const [overrideFor, setOverrideFor] = useState<{ identity: string; runId: string; reason: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (!allowed) return null;
  const submit = async () => {
    if (!overrideFor) return;
    setError(null);
    try {
      await autonomyActions.overrideContact(overrideFor.identity, overrideFor.runId.trim(), overrideFor.reason.trim());
      setOverrideFor(null);
      await qc.invalidateQueries({ queryKey: ['contention', 'ledger'] });
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Contact ledger</CardTitle>
          <CardDescription>Everyone an agent has reached out to, and until when another agent is told to hold off — so one person never gets two emails from your organization.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 p-0">
        <form
          className="flex gap-2 px-4 pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(identity.trim());
          }}
        >
          <Input aria-label="Person" value={identity} onChange={(e) => setIdentity(e.target.value)} placeholder="name@company.com (leave empty for the latest)" className="max-w-sm" />
          <Button type="submit" size="sm" variant="secondary">
            Search
          </Button>
        </form>
        {ledger.error ? (
          <div className="px-4">
            <ErrorText error={ledger.error} />
          </div>
        ) : null}
        <Table data-testid="ledger">
          <thead>
            <tr>
              <Th>Person</Th>
              <Th>Contacted</Th>
              <Th>By</Th>
              <Th>Cooldown</Th>
              <Th>Exception</Th>
            </tr>
          </thead>
          <tbody>
            {(ledger.data?.items ?? []).map((r) => (
              <tr key={r.id}>
                <Td className="text-sm">{r.externalIdentity}</Td>
                <Td className="whitespace-nowrap text-xs">
                  {when(r.contactedAt)} · {r.channel}
                </Td>
                <Td className="text-xs text-muted">agent {short(r.byAgentId)}</Td>
                <Td>{r.inCooldown ? <Badge tone="info">until {when(r.cooldownUntil)}</Badge> : <span className="text-xs text-muted">over</span>}</Td>
                <Td className="text-xs">
                  {r.overrideReason ? (
                    <span title={`by ${r.overriddenBy ?? ''}`}>Override: {r.overrideReason}</span>
                  ) : can('workspaces.manage') && r.inCooldown ? (
                    <button type="button" className="text-primary hover:underline" onClick={() => setOverrideFor({ identity: r.externalIdentity, runId: '', reason: '' })}>
                      Allow a run…
                    </button>
                  ) : null}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {ledger.data && !ledger.data.items.length ? <p className="px-4 pb-3 text-sm text-muted">No contacts recorded.</p> : null}
        {overrideFor ? (
          <div className="grid gap-2 border-t border-border px-4 py-3">
            <p className="text-sm font-medium">Allow one run to contact {overrideFor.identity} during their cooldown</p>
            <div className="flex flex-wrap gap-2">
              <Input aria-label="Run id" placeholder="Run id" value={overrideFor.runId} onChange={(e) => setOverrideFor({ ...overrideFor, runId: e.target.value })} className="w-80 font-mono" />
              <Input aria-label="Reason" placeholder="Reason (recorded with your name)" value={overrideFor.reason} onChange={(e) => setOverrideFor({ ...overrideFor, reason: e.target.value })} className="w-80" />
              <Button size="sm" variant="danger" disabled={overrideFor.runId.trim().length < 32 || overrideFor.reason.trim().length < 3} onClick={submit}>
                Record exception
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setOverrideFor(null)}>
                Cancel
              </Button>
            </div>
            {error ? <ErrorText error={error} /> : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ConflictCard({ c }: { c: WriteConflict }) {
  const qc = useQueryClient();
  const can = useCan();
  const [error, setError] = useState<unknown>(null);
  const resolve = async (runId: string) => {
    setError(null);
    try {
      await autonomyActions.resolveConflict(c.id, runId);
      await qc.invalidateQueries({ queryKey: autonomyKeys.conflicts });
    } catch (e) {
      setError(e);
    }
  };
  const open = c.resolution === 'escalated' && !c.resolvedBy;
  return (
    <li className="grid gap-1.5 rounded border border-border px-3 py-2 text-sm" data-testid="conflict">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs">{c.entityKey}</span>
        <span className="text-xs text-muted">field “{c.field}”</span>
        <Badge tone={open ? 'danger' : 'neutral'}>{open ? 'waiting for a person' : (c.resolution ?? 'in flight')}</Badge>
      </div>
      <ul className="grid gap-1">
        {c.proposals.map((p) => (
          <li key={p.run_id} className="flex flex-wrap items-center gap-2 text-xs">
            <code className="rounded bg-surface-muted px-1">{JSON.stringify(p.value)}</code>
            <span className="text-muted">
              agent {short(p.agent_id)} · run {short(p.run_id)}
              {p.risk_tier ? ` · ${p.risk_tier} risk` : ''}
            </span>
            {open && can('agents.manage') ? (
              <Button size="sm" variant="secondary" onClick={() => resolve(p.run_id)}>
                Use this one
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? <ErrorText error={error} /> : null}
    </li>
  );
}

function Conflicts() {
  const conflicts = useConflicts();
  const rows = conflicts.data?.items ?? [];
  const open = rows.filter((c) => c.resolution === 'escalated' && !c.resolvedBy);
  const rest = rows.filter((c) => !open.includes(c)).slice(-20).reverse();
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Write conflicts</CardTitle>
          <CardDescription>Two agents trying to set one field to different values are caught before either writes. Compatible changes merge; a lower-stakes one yields; two high-stakes ones wait here for you.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {conflicts.error ? <ErrorText error={conflicts.error} /> : null}
        {open.length ? (
          <ul className="grid gap-2">
            {open.map((c) => (
              <ConflictCard key={c.id} c={c} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nothing is waiting for you.</p>
        )}
        {rest.length ? (
          <details>
            <summary className="cursor-pointer text-xs text-muted">Recently settled ({rest.length})</summary>
            <ul className="mt-2 grid gap-2">
              {rest.map((c) => (
                <ConflictCard key={c.id} c={c} />
              ))}
            </ul>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ContentionViews() {
  return (
    <div className="grid gap-4">
      <Activity />
      <Locks />
      <Ledger />
      <Conflicts />
    </div>
  );
}
