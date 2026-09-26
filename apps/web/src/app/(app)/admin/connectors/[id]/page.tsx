'use client';
import { useParams, useSearchParams, useRouter } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import type { Connector } from '@vega/contracts';
import { ScopeList } from '@/components/connectors/consent-screen';
import { ReversibilityBadge } from '@/components/connectors/reversibility-badge';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { api } from '@/lib/api';
import { useCan } from '@/lib/me';
import { keys, useAction, useCatalog, useConnector, useMcpTools } from '@/lib/queries';

function Authorized() {
  const params = useSearchParams();
  return params.get('authorized') ? (
    <p role="status" className="rounded border border-border bg-surface-muted px-3 py-2 text-sm text-success">
      Connected. The provider granted exactly the scopes listed below.
    </p>
  ) : null;
}

export default function ConnectorOverview() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const can = useCan();
  const c = useConnector(id);
  const catalog = useCatalog();
  const mcp = useMcpTools(id, c.data?.kind === 'mcp');
  const [enabled, setEnabled] = useState<string[]>([]);
  useEffect(() => setEnabled(c.data?.enabledTools ?? []), [c.data?.enabledTools]);

  const save = useAction((tools: string[]) => api.patch<{ connector: Connector; authorizeUrl: string | null }>(`/v1/connectors/${id}`, { enabledTools: tools }), [keys.connectors, keys.connector(id)]);
  const test = useAction(() => api.post<{ ok: boolean; latencyMs: number; detail?: string }>(`/v1/connectors/${id}/test`), [keys.connector(id)]);
  const reauth = useAction(() => api.post<{ authorizeUrl: string }>(`/v1/connectors/${id}/reauthorize`), []);
  const revoke = useAction(() => api.delete<Connector>(`/v1/connectors/${id}`), [keys.connectors, keys.connector(id)]);

  if (!c.data) return <ErrorText error={c.error} />;
  const connector = c.data;
  const manage = can('connectors.manage') && connector.status !== 'revoked';
  const tools =
    connector.kind === 'mcp'
      ? (mcp.data ?? []).map((t) => ({ toolId: t.toolId, title: t.title || t.name, reversibility: t.effective.reversibility, scopes: [] as string[] }))
      : (catalog.data?.find((k) => k.kind === connector.kind)?.tools ?? []);
  const missing = connector.scopesRequired.filter((s) => !connector.scopesGranted.includes(s));

  return (
    <div className="grid gap-3">
      <Suspense>
        <Authorized />
      </Suspense>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>{connector.displayName}</CardTitle>
            <CardDescription>
              {connector.kind} · {connector.accountRef ?? 'account not yet known'}
            </CardDescription>
          </div>
          {manage ? (
            <div className="flex flex-wrap gap-1">
              <Button size="sm" variant="secondary" onClick={() => test.mutate(undefined)} disabled={test.isPending}>
                Test
              </Button>
              {connector.kind !== 'web' && connector.kind !== 'http' && connector.kind !== 'mcp' ? (
                <Button size="sm" variant="secondary" onClick={async () => { const r = await reauth.mutateAsync(undefined).catch(() => undefined); if (r) window.location.assign(r.authorizeUrl); }}>
                  Re-authorize
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!window.confirm(`Revoke ${connector.displayName}? The provider grant is revoked and the stored credential deleted.`)) return;
                  if (await revoke.mutateAsync(undefined).catch(() => undefined)) router.push('/admin/connectors');
                }}
              >
                Revoke
              </Button>
            </div>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {test.data ? (
            <p role="status" className={test.data.ok ? 'text-success' : 'text-risk-critical'}>
              Probe {test.data.ok ? 'succeeded' : 'failed'} in {test.data.latencyMs} ms{test.data.detail ? ` — ${test.data.detail}` : ''}.
            </p>
          ) : null}
          <ErrorText error={test.error ?? reauth.error ?? revoke.error} />
          <div className="grid gap-1">
            <span className="text-xs font-medium text-muted">Granted by the provider</span>
            <ScopeList scopes={connector.scopesGranted} />
          </div>
          {missing.length ? (
            <div className="grid gap-1 rounded border border-risk-medium p-2">
              <span className="text-xs font-medium text-risk-medium">Awaiting consent — tools needing these scopes are refused until you re-authorize:</span>
              <ScopeList scopes={missing} />
            </div>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Enabled tools</CardTitle>
            <CardDescription>Enabling a tool never widens the grant silently: new scopes require your consent at the provider.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-2">
          {tools.map((t) => (
            <label key={t.toolId} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={!manage}
                checked={enabled.includes(t.toolId)}
                onChange={(e) => setEnabled((cur) => (e.target.checked ? [...cur, t.toolId] : cur.filter((x) => x !== t.toolId)))}
              />
              <span>{t.title}</span>
              <ReversibilityBadge value={t.reversibility} />
              <span className="font-mono text-xs text-muted">{t.toolId}</span>
            </label>
          ))}
          {manage ? (
            <div>
              <Button
                size="sm"
                disabled={save.isPending}
                onClick={async () => {
                  const out = await save.mutateAsync(enabled).catch(() => undefined);
                  if (out?.authorizeUrl && window.confirm('These tools need additional permissions. Continue to the provider to grant them?')) window.location.assign(out.authorizeUrl);
                }}
              >
                Save
              </Button>
            </div>
          ) : null}
          <ErrorText error={save.error} />
        </CardContent>
      </Card>
    </div>
  );
}
