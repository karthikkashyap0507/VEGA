import {
  ConnectorRuntime,
  MemoryConnectorStore,
  MemoryInvocationStore,
  MemoryTokenBucket,
  MemoryTokenVault,
  minimalScopes,
  type ConnectorRecord,
  type ToolRegistry,
} from '@vega/connector-sdk';
import { FakeProviders } from '@vega/connector-testing';
import { launchRegistry } from '@vega/connectors';

/**
 * A sandbox the harness can run a scenario in. `fake` is in-process provider fakes (every CI
 * run); a `live` sandbox — the provider test tenants of docs/module2.md §11.1 — implements the
 * same interface with real OAuth grants, and is selected by CONNECTOR_SANDBOX=live.
 */
export interface Sandbox {
  runtime: ConnectorRuntime;
  registry: ToolRegistry;
  providers: FakeProviders;
  tenantId: string;
  account: string;
  connect(kind: ConnectorRecord['kind'], enabled: string[], config?: Record<string, unknown>): Promise<string>;
}

export const SANDBOX_TENANT = '55555555-5555-4555-8555-555555555555';
export const SANDBOX_ACCOUNT = 'owner@acme.example';

const PROVIDER: Partial<Record<ConnectorRecord['kind'], 'google' | 'microsoft' | 'slack'>> = {
  gmail: 'google',
  gcal: 'google',
  gdrive: 'google',
  outlook: 'microsoft',
  sharepoint: 'microsoft',
  slack: 'slack',
};

/** Hosts the fake sandbox answers besides the providers (the http tool's allowlisted API). */
function extraHosts(inner: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    if (new URL(req.url).host === 'api.corp.example') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return inner(req);
  }) as typeof fetch;
}

export function fakeSandbox(): Sandbox {
  const providers = new FakeProviders();
  const registry = launchRegistry();
  const connectors = new MemoryConnectorStore();
  connectors.domains = ['acme.example'];
  const vault = new MemoryTokenVault();
  const fetchImpl = extraHosts(providers.fetch);
  const client = (p: string) => ({ clientId: `${p}-client`, clientSecret: `${p}-secret`, redirectUri: `https://api.test/v1/oauth/${p}/callback`, fetchImpl });
  const runtime = new ConnectorRuntime({
    registry,
    connectors,
    vault,
    invocations: new MemoryInvocationStore(),
    buckets: new MemoryTokenBucket(),
    oauthClients: { google: client('google'), microsoft: client('microsoft'), slack: client('slack') },
    fetchImpl,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined },
  });
  let seq = 0;
  return {
    runtime,
    registry,
    providers,
    tenantId: SANDBOX_TENANT,
    account: SANDBOX_ACCOUNT,
    async connect(kind, enabled, config = {}) {
      const provider = PROVIDER[kind];
      const id = `00000000-0000-4000-8000-${(++seq).toString().padStart(12, '0')}`;
      let secretRefId: string | null = null;
      const scopes = minimalScopes(registry.toolsFor(kind), enabled);
      if (provider) {
        const t = providers.grant(provider, SANDBOX_ACCOUNT, scopes);
        secretRefId = await vault.save(SANDBOX_TENANT, { accessToken: t.access, refreshToken: t.refresh, expiresAt: Date.now() + 3_600_000, scopesGranted: scopes });
      }
      connectors.add({ id, tenantId: SANDBOX_TENANT, kind, status: 'active', scopesGranted: scopes, enabledTools: enabled, config, secretRefId });
      return id;
    },
  };
}
