'use client';
import { Plug, Server } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import type { Connector } from '@vega/contracts';
import { ConnectorCard } from '@/components/connectors/connector-card';
import { ConsentScreen } from '@/components/connectors/consent-screen';
import { ReversibilityBadge } from '@/components/connectors/reversibility-badge';
import { ErrorText } from '@/components/error-text';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogTrigger } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useCan } from '@/lib/me';
import { keys, useAction, useCatalog, useConnectors, useConsent, useWorkspaces } from '@/lib/queries';

/**
 * Connector gallery — docs/module2.md §6.1 — with the authorize flow: pick tools, read the
 * consent transparency screen (generated from declarations), then go to the provider.
 */
function AddConnectorDialog() {
  const catalog = useCatalog();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState('');
  const [name, setName] = useState('');
  const [tools, setTools] = useState<string[]>([]);
  const [allowlist, setAllowlist] = useState('');
  const entry = (catalog.data ?? []).find((c) => c.kind === kind);
  const consent = useConsent(kind, tools);
  const create = useAction(
    (body: unknown) => api.post<{ connector: Connector; authorizeUrl: string | null }>('/v1/connectors', body),
    [keys.connectors],
  );
  const offered = (catalog.data ?? []).filter((c) => c.kind !== 'mcp');

  const choose = (k: string) => {
    const e = (catalog.data ?? []).find((c) => c.kind === k);
    setKind(k);
    setName(e?.displayName ?? '');
    // Default: the read-only tools. Anything that changes state is opted into explicitly.
    setTools((e?.tools ?? []).filter((t) => t.reversibility === 'R0').map((t) => t.toolId));
  };

  const submit = async () => {
    const body = {
      kind,
      displayName: name || entry?.displayName,
      enabledTools: tools,
      config: kind === 'http' ? { allowlist: allowlist.split(/\s+/).filter(Boolean) } : {},
    };
    const out = await create.mutateAsync(body).catch(() => undefined);
    if (!out) return;
    if (out.authorizeUrl) window.location.assign(out.authorizeUrl);
    else setOpen(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setKind('');
          setTools([]);
          create.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plug aria-hidden /> Add connector
        </Button>
      </DialogTrigger>
      <DialogContent title="Add a connector" description="Choose what it may do. You will see exactly what is requested before anything is granted.">
        <div className="grid max-h-[70vh] gap-3 overflow-y-auto">
          <Field id="c-kind" label="Service">
            <Select id="c-kind" value={kind} onChange={(e) => choose(e.target.value)}>
              <option value="">Choose…</option>
              {offered.map((c) => (
                <option key={c.kind} value={c.kind} disabled={!c.available}>
                  {c.displayName}
                  {c.available ? '' : ' (not configured for this deployment)'}
                </option>
              ))}
            </Select>
          </Field>
          {entry ? (
            <>
              <Field id="c-name" label="Display name">
                <Input id="c-name" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <fieldset className="grid gap-1">
                <legend className="text-sm font-medium">Tools</legend>
                {entry.tools.map((t) => (
                  <label key={t.toolId} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={tools.includes(t.toolId)}
                      onChange={(e) => setTools((cur) => (e.target.checked ? [...cur, t.toolId] : cur.filter((x) => x !== t.toolId)))}
                    />
                    <span className="grid gap-0.5">
                      <span>
                        {t.title} <ReversibilityBadge value={t.reversibility} />
                      </span>
                      <span className="text-xs text-muted">{t.description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              {kind === 'http' ? (
                <Field id="c-allow" label="Allowed origins" hint="One exact origin per line, e.g. https://api.example.com — no paths, no wildcards.">
                  <textarea id="c-allow" className="min-h-20 rounded border border-border bg-surface px-2 py-1 font-mono text-xs" value={allowlist} onChange={(e) => setAllowlist(e.target.value)} />
                </Field>
              ) : null}
              <div className="rounded border border-border bg-surface-muted/40 p-3">
                {consent.data ? <ConsentScreen consent={consent.data} /> : <p className="text-xs text-muted">Loading what will be requested…</p>}
                <ErrorText error={consent.error} />
              </div>
              <ErrorText error={create.error} />
              <Button type="button" onClick={submit} disabled={create.isPending || !consent.data}>
                {entry.provider === 'none' ? 'Create' : `Continue to ${entry.displayName}`}
              </Button>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AttachMcpDialog() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ displayName: '', serverUrl: '', slug: '', apiKey: '' });
  const attach = useAction(
    (body: unknown) => api.post<{ connector: Connector; discoveryError: string | null }>('/v1/mcp/servers', body),
    [keys.connectors],
  );
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) attach.reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary">
          <Server aria-hidden /> Attach MCP server
        </Button>
      </DialogTrigger>
      <DialogContent
        title="Attach an MCP server"
        description="Its tools are registered as irreversible, external, approval-required and capped at SUPERVISED until you declare each one."
      >
        <form
          className="grid gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const out = await attach
              .mutateAsync({ displayName: form.displayName, serverUrl: form.serverUrl, slug: form.slug, ...(form.apiKey ? { apiKey: form.apiKey } : {}) })
              .catch(() => undefined);
            if (out) window.location.assign(`/admin/connectors/${out.connector.id}/tools`);
          }}
        >
          <Field id="m-name" label="Display name">
            <Input id="m-name" value={form.displayName} onChange={set('displayName')} required />
          </Field>
          <Field id="m-url" label="Server URL (Streamable HTTP)">
            <Input id="m-url" type="url" placeholder="https://tools.example.com/mcp" value={form.serverUrl} onChange={set('serverUrl')} required />
          </Field>
          <Field id="m-slug" label="Short name" hint="Lowercase; tools become mcp.<short name>.<tool>.">
            <Input id="m-slug" value={form.slug} onChange={set('slug')} pattern="[a-z][a-z0-9_]*" required />
          </Field>
          <Field id="m-key" label="API key (optional)" hint="Stored encrypted; sent as a bearer token.">
            <Input id="m-key" type="password" autoComplete="off" value={form.apiKey} onChange={set('apiKey')} />
          </Field>
          <ErrorText error={attach.error} />
          <Button type="submit" disabled={attach.isPending}>
            {attach.isPending ? 'Discovering tools…' : 'Attach'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function OAuthNotice() {
  const params = useSearchParams();
  const error = params.get('error');
  if (!error) return null;
  return (
    <p role="alert" className="rounded border border-risk-critical bg-risk-critical-bg px-3 py-2 text-sm text-risk-critical">
      The connection was not completed ({error.replace(/[-_]/g, ' ')}). Nothing was granted. You can try again.
    </p>
  );
}

export default function ConnectorsPage() {
  const can = useCan();
  const connectors = useConnectors();
  const workspaces = useWorkspaces();
  const names = useMemo(() => new Map((workspaces.data ?? []).map((w) => [w.id, w.name])), [workspaces.data]);
  const visible = (connectors.data ?? []).filter((c) => c.status !== 'revoked');
  const revoked = (connectors.data ?? []).filter((c) => c.status === 'revoked');
  return (
    <div className="grid gap-4">
      <Suspense>
        <OAuthNotice />
      </Suspense>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Connectors</CardTitle>
            <CardDescription>The accounts agents act through. Every permission is derived from the tools you enable.</CardDescription>
          </div>
          {can('connectors.manage') ? (
            <div className="flex gap-2">
              <AttachMcpDialog />
              <AddConnectorDialog />
            </div>
          ) : null}
        </CardHeader>
        <CardContent>
          {connectors.isPending ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : visible.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted">No connectors yet.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {visible.map((c) => (
                <ConnectorCard key={c.id} connector={c} workspaceName={c.workspaceId ? names.get(c.workspaceId) : undefined} />
              ))}
            </div>
          )}
          <ErrorText error={connectors.error} />
        </CardContent>
      </Card>
      {revoked.length ? (
        <details className="text-sm text-muted">
          <summary>{revoked.length} revoked connector(s)</summary>
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {revoked.map((c) => (
              <ConnectorCard key={c.id} connector={c} />
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}
