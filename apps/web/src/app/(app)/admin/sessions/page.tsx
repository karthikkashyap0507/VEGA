'use client';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { api } from '@/lib/api';
import { keys, useAction, useSessions } from '@/lib/queries';

const when = (iso: string) => new Date(iso).toLocaleString();

export default function SessionsPage() {
  const sessions = useSessions();
  const revoke = useAction((id: string) => api.delete(`/v1/sessions/${id}`), [keys.sessions]);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Your active sessions</CardTitle>
          <CardDescription>Tokens rotate every few minutes; a reused old token ends the whole session.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="px-0 py-0">
        <Table>
          <thead>
            <tr>
              <Th>Device</Th>
              <Th>Address</Th>
              <Th>Signed in</Th>
              <Th>Last seen</Th>
              <Th className="text-right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {(sessions.data ?? []).map((s) => (
              <tr key={s.id}>
                <Td className="max-w-64 truncate" title={s.userAgent ?? ''}>
                  {s.userAgent ?? 'Unknown'} {s.current ? <Badge tone="info">this session</Badge> : null}
                </Td>
                <Td className="font-mono text-xs">{s.ip ?? '—'}</Td>
                <Td>{when(s.createdAt)}</Td>
                <Td>{when(s.lastSeenAt)}</Td>
                <Td className="text-right">
                  {s.current ? null : (
                    <Button size="sm" variant="ghost" onClick={() => revoke.mutate(s.id)}>
                      Revoke
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <div className="px-4 py-2">
          <ErrorText error={revoke.error} />
        </div>
      </CardContent>
    </Card>
  );
}
