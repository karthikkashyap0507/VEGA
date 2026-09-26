'use client';
import { useParams } from 'next/navigation';
import { HealthSparkline } from '@/components/connectors/health-sparkline';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { useConnectorHealth } from '@/lib/queries';

/** Connector health — docs/module2.md §6.4. Refreshes every 30s; figures come from the ledger and events. */
export default function ConnectorHealthPage() {
  const { id } = useParams<{ id: string }>();
  const h = useConnectorHealth(id);
  if (!h.data) return <ErrorText error={h.error} />;
  const { invocations: inv, events } = h.data;
  const total = inv.succeeded + inv.failed;
  const rate = total ? `${((inv.succeeded / total) * 100).toFixed(1)}%` : '—';
  const count = (re: RegExp) => events.filter((e) => re.test(e.kind)).length;
  const stat = (label: string, value: string) => (
    <div className="grid gap-0.5 rounded border border-border p-2">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-base font-semibold">{value}</span>
    </div>
  );
  return (
    <div className="grid gap-3">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Health</CardTitle>
            <CardDescription>
              Status <Badge tone={h.data.status === 'active' ? 'success' : 'danger'}>{h.data.status}</Badge> · last success{' '}
              {h.data.lastOkAt ? new Date(h.data.lastOkAt).toLocaleString() : 'never'}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {stat('Success rate (7d)', rate)}
            {stat('p50 latency', inv.p50Ms === null ? '—' : `${inv.p50Ms} ms`)}
            {stat('p99 latency', inv.p99Ms === null ? '—' : `${inv.p99Ms} ms`)}
            {stat('Rate-limit events', String(count(/rate_limited/)))}
            {stat('Auth refreshes', String(count(/auth_refreshed/)))}
          </div>
          <HealthSparkline events={events} />
          {inv.errors.length ? (
            <div className="flex flex-wrap gap-1 text-xs">
              {inv.errors.map((e) => (
                <Badge key={e.code} tone="danger">
                  {e.code} × {e.count}
                </Badge>
              ))}
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Recent events</CardTitle>
        </CardHeader>
        <CardContent className="px-0 py-0">
          <Table>
            <thead>
              <tr>
                <Th>When</Th>
                <Th>Event</Th>
                <Th>Detail</Th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <Td className="whitespace-nowrap text-xs">{new Date(e.createdAt).toLocaleString()}</Td>
                  <Td>
                    <Badge tone={/error|expired|failed|unconfirmed/.test(e.kind) ? 'danger' : 'neutral'}>{e.kind}</Badge>
                  </Td>
                  <Td className="font-mono text-xs text-muted">{Object.keys(e.detail).length ? JSON.stringify(e.detail) : ''}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
