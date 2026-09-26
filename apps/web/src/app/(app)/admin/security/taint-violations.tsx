'use client';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ProvenanceChip } from '@/components/provenance/taint';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { useCan } from '@/lib/me';
import { useAction } from '@/lib/queries';

/**
 * Taint violations — module3.md §8.4, for an incident responder: what was attempted, which
 * argument, which sources, which program, how severe. A violation is never deleted; it is
 * acknowledged. (The Security Center proper arrives with Module 8.)
 */
interface Violation {
  id: string;
  runId: string;
  nodeId: string | null;
  toolId: string;
  kind: 'RECIPIENT' | 'CEILING' | 'PROVENANCE' | 'SCHEMA';
  attemptedTaint: 'TRUSTED' | 'ORG' | 'UNTRUSTED';
  declaredMax: string;
  argPath: string;
  sourceIds: string[];
  programRef: string;
  severity: 'HIGH' | 'CRITICAL';
  detail: string;
  acknowledgedAt: string | null;
  createdAt: string;
}

const KIND: Record<Violation['kind'], string> = {
  RECIPIENT: 'Untrusted content tried to choose a recipient',
  CEILING: 'Untrusted content exceeded what an internal tool accepts',
  PROVENANCE: 'A value without provenance reached a tool',
  SCHEMA: 'The quarantined extractor returned something outside its schema',
};

export function TaintViolations() {
  const can = useCan();
  const [open, setOpen] = useState(true);
  const q = useQuery({
    queryKey: ['taint-violations', open],
    queryFn: () => api.get<{ items: Violation[] }>(`/v1/security/taint-violations?limit=100${open ? '&unacknowledged=true' : ''}`),
    enabled: can('audit.read'),
  });
  const ack = useAction((id: string) => api.post(`/v1/security/taint-violations/${id}/acknowledge`), [['taint-violations', open]]);
  if (!can('audit.read')) return null;
  const items = q.data?.items ?? [];
  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Taint violations</CardTitle>
          <CardDescription>Security incidents: attempts by untrusted content to steer a privileged action. Each one paged when it happened.</CardDescription>
        </div>
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Unacknowledged only
        </label>
      </CardHeader>
      <CardContent className="px-0 py-0">
        {q.isPending ? (
          <p className="px-4 py-3 text-sm text-muted">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted">No {open ? 'open ' : ''}violations.</p>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>What was attempted</Th>
                <Th>Where</Th>
                <Th>Sources</Th>
                <Th>Severity</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((v) => (
                <tr key={v.id}>
                  <Td className="whitespace-nowrap text-xs">{new Date(v.createdAt).toLocaleString()}</Td>
                  <Td className="text-sm">
                    <div>{KIND[v.kind]}</div>
                    <div className="text-xs text-muted">{v.detail}</div>
                  </Td>
                  <Td className="font-mono text-xs">
                    {v.toolId} · {v.argPath}
                    <div className="text-muted">
                      run {v.runId}
                      {v.nodeId ? ` · ${v.nodeId}` : ''} · program {v.programRef.slice(7, 19)}
                    </div>
                  </Td>
                  <Td>
                    <ProvenanceChip taint={v.attemptedTaint} sourceIds={v.sourceIds} />
                  </Td>
                  <Td>
                    <Badge tone="danger">{v.severity}</Badge>
                  </Td>
                  <Td className="text-right">
                    {v.acknowledgedAt ? (
                      <span className="text-xs text-muted">acknowledged</span>
                    ) : can('policy.manage') ? (
                      <Button size="sm" variant="secondary" onClick={() => ack.mutate(v.id)}>
                        Acknowledge
                      </Button>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        <ErrorText error={q.error ?? ack.error} />
      </CardContent>
    </Card>
  );
}

interface Contact {
  id: string;
  email: string;
  displayName: string | null;
  company: string | null;
}

/** The `contacts` registry: the only people content-derived recipients can ever resolve to. */
export function TrustedContacts() {
  const can = useCan();
  const q = useQuery({ queryKey: ['trusted-contacts'], queryFn: () => api.get<{ items: Contact[] }>('/v1/trusted-contacts'), enabled: can('connectors.read') });
  const add = useAction((body: { email: string; displayName?: string }) => api.post('/v1/trusted-contacts', body), [['trusted-contacts']]);
  const remove = useAction((id: string) => api.delete(`/v1/trusted-contacts/${id}`), [['trusted-contacts']]);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  if (!can('connectors.read')) return null;
  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Trusted contacts</CardTitle>
          <CardDescription>When a plan resolves a recipient from content, it can only ever become one of these people or someone in your directory.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3">
        {can('connectors.manage') ? (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await add.mutateAsync({ email, ...(name ? { displayName: name } : {}) }).catch(() => undefined)) {
                setEmail('');
                setName('');
              }
            }}
          >
            <Input aria-label="Contact email" type="email" placeholder="partner@company.example" value={email} onChange={(e) => setEmail(e.target.value)} required className="max-w-xs" />
            <Input aria-label="Contact name" placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)} className="max-w-xs" />
            <Button size="sm" type="submit" disabled={add.isPending}>
              Trust contact
            </Button>
          </form>
        ) : null}
        <ErrorText error={add.error ?? remove.error ?? q.error} />
        <ul className="grid gap-1 text-sm">
          {(q.data?.items ?? []).map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1">
              <span>
                {c.displayName ? `${c.displayName} · ` : ''}
                <span className="font-mono text-xs">{c.email}</span>
              </span>
              {can('connectors.manage') ? (
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(c.id)}>
                  Remove
                </Button>
              ) : null}
            </li>
          ))}
          {q.data && q.data.items.length === 0 ? <li className="text-xs text-muted">No trusted contacts yet.</li> : null}
        </ul>
      </CardContent>
    </Card>
  );
}
