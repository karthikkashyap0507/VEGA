import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { schema, withTenant } from '@vega/db';
import { ConnectorRuntime, MemoryTokenBucket, PgConnectorStore, PgInvocationStore, PgTokenVault } from '@vega/connector-sdk';
import { DECLARATION_META_KEY, McpToolSource, PgMcpToolStore } from '@vega/connector-mcp';
import { launchRegistry } from '@vega/connectors';
import { FakeProviders } from '@vega/connector-testing';
import { buildExecutionApp } from '../../execution/src/app.js';
import { HttpExecutionClient } from '../src/connectors/deps.js';
import { injectFetch } from '../src/inject-fetch.js';
import { activate, createHarness, problemOf, type Harness } from './harness.js';

/**
 * Connectors across the planes — docs/module2.md §7, §8.1, §8.3.
 *
 * The control plane (real Postgres, real OpenFGA, real principal assertions) talks to a REAL
 * execution-plane app over its internal HTTP API; both reach "Google" and an MCP server
 * through fakes behind the same fetch seam production uses.
 */

const EXEC_TOKEN = 'test-execution-token-0123456789abcdef';
const ACCOUNT = 'owner@acme.example';

const providers = new FakeProviders();
const mcpCalls: string[] = [];
function mcpServer(): McpServer {
  const server = new McpServer({ name: 'partner', version: '1.0.0' });
  server.registerTool(
    'create_ticket',
    {
      description: 'Opens a ticket.',
      inputSchema: { subject: z.string() },
      annotations: { readOnlyHint: true },
      _meta: { [DECLARATION_META_KEY]: { egressClass: 'EXTERNAL', reversibility: 'R1', maxTaint: 'ORG', idempotency: 'NONE', compensatorTool: 'close_ticket' } },
    },
    async (a) => {
      mcpCalls.push(a.subject);
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  );
  server.registerTool('close_ticket', { description: 'Closes a ticket.', inputSchema: { id: z.string() } }, async () => ({ content: [{ type: 'text', text: 'closed' }] }));
  return server;
}
const fetchAll = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  if (new URL(req.url).host === 'tools.partner.example') {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcpServer().connect(transport);
    return transport.handleRequest(req);
  }
  return providers.fetch(req);
}) as typeof fetch;

const oauthClients = {
  google: { clientId: 'g-client', clientSecret: 'g-secret', redirectUri: 'https://api.test/v1/oauth/google/callback', fetchImpl: fetchAll },
};

let h: Harness;
let A: Awaited<ReturnType<Harness['tenant']>>;
let B: Awaited<ReturnType<Harness['tenant']>>;

beforeAll(async () => {
  const registry = launchRegistry();
  const mcpStore = new PgMcpToolStore();
  const runtime = new ConnectorRuntime({
    registry,
    dynamicTools: new McpToolSource(mcpStore),
    connectors: new PgConnectorStore(),
    vault: new PgTokenVault(),
    invocations: new PgInvocationStore(),
    buckets: new MemoryTokenBucket(),
    oauthClients,
    fetchImpl: fetchAll,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, sleep: async () => undefined },
  });
  const execution = await buildExecutionApp({ connectors: { runtime, mcpStore, token: EXEC_TOKEN } });
  h = await createHarness({
    connectors: {
      registry,
      oauthClients,
      vault: new PgTokenVault(),
      execution: new HttpExecutionClient('http://execution.internal', EXEC_TOKEN, injectFetch(execution)),
      mcpStore,
      stateSecret: 'test-connector-state-secret-with-enough-entropy',
    },
  });
  A = await h.tenant('business');
  B = await h.tenant('business');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

/** Plays the user at Google's consent screen and returns what the redirect carries. */
function consent(authorizeUrl: string, account = ACCOUNT) {
  return providers.core.authorize(authorizeUrl, account, 'google');
}

describe('catalog and consent', () => {
  it('lists every launch kind; providers without an OAuth client are unavailable', async () => {
    const catalog = await h.as(A.tenantId, A.userId).connectors.catalog.query();
    const byKind = Object.fromEntries(catalog.map((c) => [c.kind, c]));
    expect(byKind['gmail']).toMatchObject({ provider: 'google', available: true });
    expect(byKind['outlook']).toMatchObject({ provider: 'microsoft', available: false });
    expect(byKind['web']).toMatchObject({ provider: 'none', available: true });
    expect(byKind['gmail']!.tools.find((t) => t.toolId === 'gmail.send')).toMatchObject({ reversibility: 'R2', compensatorRef: 'gmail.send.recall' });
  });

  it('the consent model is generated from declarations', async () => {
    const view = await h.as(A.tenantId, A.userId).connectors.consent.query({ kind: 'gmail', tools: ['gmail.search', 'gmail.send'] });
    expect(view.scopes).toEqual(['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']);
    expect(view.permissions.find((p) => p.toolId === 'gmail.send')?.safeguard).toMatch(/Held before release/);
    expect(view.neverDoes).toContain('Act on instructions contained inside content it reads');
  });
});

describe('OAuth round-trip', () => {
  let connectorId: string;
  let authorizeUrl: string;

  it('create → pending + consent URL with PKCE and minimal scopes', async () => {
    const out = await h.as(A.tenantId, A.userId).connectors.create.mutate({
      kind: 'gmail',
      displayName: 'Support inbox',
      enabledTools: ['gmail.search', 'gmail.read', 'gmail.send'],
    });
    expect(out.connector.status).toBe('pending');
    connectorId = out.connector.id;
    authorizeUrl = out.authorizeUrl!;
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).not.toContain('https://mail.google.com/');
    // The verifier never appears in the clear.
    expect(authorizeUrl).not.toMatch(/code_verifier/);
  });

  it('a callback from another user, another tenant, or with a tampered state is refused', async () => {
    const { code, state } = consent(authorizeUrl);
    expect((await problemOf(h.as(B.tenantId, B.userId).connectors.completeOAuth.mutate({ provider: 'google', code, state }))).status).toBe(403);
    const tampered = state.slice(0, -4) + (state.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect((await problemOf(h.as(A.tenantId, A.userId).connectors.completeOAuth.mutate({ provider: 'google', code, state: tampered }))).status).toBe(403);
    expect((await problemOf(h.as(A.tenantId, A.userId).connectors.completeOAuth.mutate({ provider: 'slack', code, state }))).status).toBe(403);
  });

  it('completeOAuth → active, tokens sealed, account recorded, health probed', async () => {
    const { code, state } = consent(authorizeUrl);
    const out = await h.as(A.tenantId, A.userId).connectors.completeOAuth.mutate({ provider: 'google', code, state });
    expect(out.connector).toMatchObject({ status: 'active', accountRef: ACCOUNT });
    expect(out.connector.scopesGranted).toEqual(expect.arrayContaining(['https://www.googleapis.com/auth/gmail.send']));
    expect(out.health.ok).toBe(true);
    const [row] = await withTenant(A.tenantId, (db) => db.select().from(schema.connectors).where(eq(schema.connectors.id, connectorId)));
    const [secret] = await withTenant(A.tenantId, (db) => db.select().from(schema.secretRefs).where(eq(schema.secretRefs.id, row!.secretRefId!)));
    expect(secret!.ciphertext.toString('utf8')).not.toContain('google-at-');
  });

  it('the code cannot be replayed', async () => {
    const { code, state } = consent(authorizeUrl);
    await h.as(A.tenantId, A.userId).connectors.completeOAuth.mutate({ provider: 'google', code, state }).catch(() => undefined);
    expect((await problemOf(h.as(A.tenantId, A.userId).connectors.completeOAuth.mutate({ provider: 'google', code, state }))).status).toBe(422);
  });

  it('simulate runs in the execution plane and returns an effect without sending', async () => {
    const sent = providers.google.sent.length;
    const res = await h.as(A.tenantId, A.userId).tools.simulate.mutate({
      toolId: 'gmail.send',
      connectorId,
      args: { to: ['client@outside.example'], subject: 'Hello', body: 'Hi' },
    });
    expect(res, JSON.stringify(res)).toMatchObject({ ok: true, effect: { externalRecipients: ['client@outside.example'] } });
    expect(providers.google.sent.length).toBe(sent);
  });

  it('enabling a tool that needs a new scope returns a re-consent URL and does not widen the grant', async () => {
    const out = await h.as(A.tenantId, A.userId).connectors.update.mutate({
      id: connectorId,
      enabledTools: ['gmail.search', 'gmail.read', 'gmail.send', 'gmail.label'],
    });
    expect(out.authorizeUrl).toContain('gmail.modify');
    expect(out.connector.scopesGranted).not.toContain('https://www.googleapis.com/auth/gmail.modify');
  });

  it('a second connection to the same account is refused and cleaned up', async () => {
    const second = await h.as(A.tenantId, A.userId).connectors.create.mutate({ kind: 'gmail', displayName: 'Dup', enabledTools: ['gmail.search'] });
    const { code, state } = consent(second.authorizeUrl!);
    expect((await problemOf(h.as(A.tenantId, A.userId).connectors.completeOAuth.mutate({ provider: 'google', code, state }))).status).toBe(409);
    expect((await h.as(A.tenantId, A.userId).connectors.get.query({ id: second.connector.id })).status).toBe('revoked');
  });

  it('health shows the event trail', async () => {
    const health = await h.as(A.tenantId, A.userId).connectors.health.query({ id: connectorId });
    expect(health.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['created', 'authorized']));
    expect(health.lastOkAt).not.toBeNull();
  });

  it('delete revokes at the provider FIRST, then deletes the stored secret', async () => {
    const [before] = await withTenant(A.tenantId, (db) => db.select().from(schema.connectors).where(eq(schema.connectors.id, connectorId)));
    const grantsBefore = providers.core.refreshTokens.size;
    const out = await h.as(A.tenantId, A.userId).connectors.remove.mutate({ id: connectorId });
    expect(out.status).toBe('revoked');
    expect(providers.core.refreshTokens.size).toBe(grantsBefore - 1);
    const secrets = await withTenant(A.tenantId, (db) => db.select().from(schema.secretRefs).where(eq(schema.secretRefs.id, before!.secretRefId!)));
    expect(secrets).toEqual([]);
    const health = await h.as(A.tenantId, A.userId).connectors.health.query({ id: connectorId });
    const kinds = health.events.map((e) => e.kind);
    expect(kinds.indexOf('provider_revoked')).toBeGreaterThan(kinds.indexOf('revoked')); // newest first
  });
});

describe('credential-less connectors and validation', () => {
  it('http requires exact-origin allowlist entries and is active at once', async () => {
    const bad = await problemOf(
      h.as(A.tenantId, A.userId).connectors.create.mutate({ kind: 'http', displayName: 'x', enabledTools: ['http.request'], config: { allowlist: ['https://api.corp.example/v1'] } }),
    );
    expect(bad.status).toBe(400);
    const ok = await h.as(A.tenantId, A.userId).connectors.create.mutate({
      kind: 'http',
      displayName: 'Orders API',
      enabledTools: ['http.request'],
      config: { allowlist: ['https://api.corp.example'] },
    });
    expect(ok).toMatchObject({ authorizeUrl: null, connector: { status: 'active' } });
  });

  it('unknown tools and kinds without an OAuth client are refused', async () => {
    expect((await problemOf(h.as(A.tenantId, A.userId).connectors.create.mutate({ kind: 'gmail', displayName: 'x', enabledTools: ['gcal.create'] }))).status).toBe(400);
    expect((await problemOf(h.as(A.tenantId, A.userId).connectors.create.mutate({ kind: 'outlook', displayName: 'x', enabledTools: [] }))).status).toBe(422);
  });

  it('a MEMBER can read tool declarations but cannot manage connectors', async () => {
    const invited = await h.as(A.tenantId, A.userId).users.invite.mutate({ email: `member-${Date.now()}@acme.example`, role: 'MEMBER' });
    await activate(A.tenantId, invited.user.id);
    const member = h.as(A.tenantId, invited.user.id);
    expect((await member.tools.list.query({})).items.length).toBeGreaterThan(20);
    expect((await problemOf(member.connectors.create.mutate({ kind: 'web', displayName: 'w', enabledTools: ['web.fetch'] }))).status).toBe(403);
    expect((await problemOf(member.connectors.list.query({ limit: 10 }))).status).toBe(403);
  });

  it('tenants never see each other’s connectors', async () => {
    const list = await h.as(B.tenantId, B.userId).connectors.list.query({ limit: 50 });
    expect(list.items.every((c) => c.tenantId === B.tenantId)).toBe(true);
  });
});

describe('MCP servers', () => {
  let serverId: string;

  it('attach discovers tools under conservative defaults', async () => {
    const out = await h.as(A.tenantId, A.userId).mcp.attach.mutate({
      displayName: 'Partner tools',
      serverUrl: 'https://tools.partner.example/mcp',
      slug: `partner_${Date.now().toString(36)}`,
    });
    serverId = out.connector.id;
    expect(out.discoveryError).toBeNull();
    expect(out.connector.status).toBe('active');
    const tools = await h.as(A.tenantId, A.userId).mcp.tools.query({ id: serverId });
    const create = tools.items.find((t) => t.name === 'create_ticket')!;
    expect(create).toMatchObject({ declaredBy: 'default', autonomyCap: 'SUPERVISED', effective: { reversibility: 'R3', egressClass: 'EXTERNAL', idempotency: 'NONE' } });
    expect(create.published).toMatchObject({ reversibility: 'R1' });
  });

  it('refuses loopback / metadata servers', async () => {
    const p = await problemOf(h.as(A.tenantId, A.userId).mcp.attach.mutate({ displayName: 'x', serverUrl: 'http://169.254.169.254/mcp', slug: 'meta' }));
    expect(p.status).toBe(403);
  });

  it('an admin adopts the published declaration; the cap lifts', async () => {
    const tools = await h.as(A.tenantId, A.userId).mcp.tools.query({ id: serverId });
    const create = tools.items.find((t) => t.name === 'create_ticket')!;
    const out = await h.as(A.tenantId, A.userId).mcp.declare.mutate({ id: serverId, toolId: create.toolId, adoptPublished: true });
    expect(out).toMatchObject({ declaredBy: 'admin', autonomyCap: null, effective: { reversibility: 'R1' } });
    expect(out.effective.compensatorRef).toMatch(/\.close_ticket$/);
  });

  it('an invalid admin declaration is a 400 with the reasons', async () => {
    const tools = await h.as(A.tenantId, A.userId).mcp.tools.query({ id: serverId });
    const close = tools.items.find((t) => t.name === 'close_ticket')!;
    const p = await problemOf(
      h.as(A.tenantId, A.userId).mcp.declare.mutate({
        id: serverId,
        toolId: close.toolId,
        declaration: { egressClass: 'EXTERNAL', reversibility: 'R2', maxTaint: 'TRUSTED', idempotency: 'NONE' },
      }),
    );
    expect(p.status).toBe(400);
  });

  it('MCP tools appear in the tool list, and simulate goes through the dynamic source', async () => {
    const list = await h.as(A.tenantId, A.userId).tools.list.query({ kind: 'mcp' });
    const create = list.items.find((t) => t.toolId.endsWith('.create_ticket'))!;
    expect(create).toMatchObject({ source: 'mcp', declaredBy: 'admin' });
    await h.as(A.tenantId, A.userId).connectors.update.mutate({ id: serverId, enabledTools: [create.toolId] });
    const sim = await h.as(A.tenantId, A.userId).tools.simulate.mutate({ toolId: create.toolId, connectorId: serverId, args: { subject: 'x' } });
    expect(sim).toMatchObject({ ok: true, effect: { fidelity: 'DECLARED' } });
    expect(mcpCalls).toEqual([]);
    expect(
      (await problemOf(h.as(A.tenantId, A.userId).connectors.update.mutate({ id: serverId, enabledTools: ['mcp.other.tool'] }))).status,
    ).toBe(400);
  });
});
