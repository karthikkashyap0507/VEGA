import { describe, expect, it } from 'vitest';
import {
  ConnectorRuntime,
  MemoryConnectorStore,
  MemoryInvocationStore,
  MemoryTokenBucket,
  MemoryTokenVault,
} from '@vega/connector-sdk';
import { MemoryMcpToolStore } from '@vega/connector-mcp';
import { launchRegistry } from '@vega/connectors';
import { buildExecutionApp } from '../src/app.js';

/** The execution plane's internal connector API refuses anyone without the service token. */

const TENANT = '33333333-3333-4333-8333-333333333333';
const CONNECTOR = '44444444-4444-4444-8444-444444444444';

async function app() {
  const connectors = new MemoryConnectorStore().add({
    id: CONNECTOR,
    tenantId: TENANT,
    kind: 'http',
    status: 'active',
    scopesGranted: [],
    enabledTools: ['http.request'],
    config: { allowlist: ['https://api.corp.example'] },
    secretRefId: null,
  });
  const runtime = new ConnectorRuntime({
    registry: launchRegistry(),
    connectors,
    vault: new MemoryTokenVault(),
    invocations: new MemoryInvocationStore(),
    buckets: new MemoryTokenBucket(),
    oauthClients: {},
  });
  return buildExecutionApp({ connectors: { runtime, mcpStore: new MemoryMcpToolStore(), token: 'svc-token-abcdef' } });
}

const body = { tenantId: TENANT, connectorId: CONNECTOR, toolId: 'http.request', args: { method: 'GET', url: 'https://api.corp.example/x', headers: {} } };

describe('execution internal connector API', () => {
  it.each([undefined, 'Bearer wrong-token-xxxxxxx', 'svc-token-abcdef'])('refuses authorization %s', async (authorization) => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/internal/tools/simulate', payload: body, headers: authorization ? { authorization } : {} });
    expect(res.statusCode).toBe(401);
  });

  it('simulates with the service token', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/internal/tools/simulate', payload: body, headers: { authorization: 'Bearer svc-token-abcdef' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, effect: { fidelity: 'DECLARED', externalRecipients: ['https://api.corp.example'] } });
  });

  it('health endpoints stay unauthenticated (probes)', async () => {
    const a = await app();
    expect((await a.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('rejects malformed input', async () => {
    const a = await app();
    const res = await a.inject({ method: 'POST', url: '/internal/tools/execute', payload: { tenantId: 'nope' }, headers: { authorization: 'Bearer svc-token-abcdef' } });
    expect(res.statusCode).toBe(400);
  });
});
