import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COOKIE, createGatewayHarness, type GatewayHarness } from './harness.js';

/**
 * Public connector/tool surface — docs/module2.md §7. The load-bearing assertion is the first
 * one: `execute` is NOT reachable from the public listener, whatever the method or caller.
 */

let h: GatewayHarness;
let cookie: string;

beforeAll(async () => {
  h = await createGatewayHarness();
  const t = await h.tenant('business');
  cookie = (await h.signIn(t.subject)).cookie;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('execute is not public', () => {
  it.each(['POST', 'GET', 'PUT', 'PATCH'] as const)('%s /v1/tools/:toolId/execute → 404, even authenticated', async (method) => {
    for (const cookies of [{}, { [COOKIE]: cookie }]) {
      const res = await h.gateway.inject({ method, url: '/v1/tools/gmail.send/execute', cookies, payload: method === 'GET' ? undefined : { connectorId: 'x', args: {} } });
      expect(res.statusCode).toBe(404);
    }
  });

  it('no registered route and no OpenAPI path mentions execute', async () => {
    expect(h.gateway.printRoutes()).not.toMatch(/execute/);
    const doc = await h.gateway.inject({ method: 'GET', url: '/v1/openapi.json' });
    const paths = Object.keys((doc.json() as { paths?: Record<string, unknown> }).paths ?? {});
    expect(paths.filter((p) => /execute/.test(p))).toEqual([]);
    expect(paths).toEqual(expect.arrayContaining(['/v1/connectors', '/v1/tools', '/v1/tools/{toolId}/simulate', '/v1/mcp/servers']));
  });
});

describe('connector routes', () => {
  it('require a session', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/connectors' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
  });

  it('answer 503 problem+json when the deployment has no connector runtime', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/tools', cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 503 });
  });

  it('the OAuth callback sends a denied consent back to the web app, not to an error page', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/oauth/google/callback?error=access_denied', cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://web.test/admin/connectors?error=access_denied');
  });

  it('the OAuth callback with a bad state redirects with an error and never 500s', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/oauth/google/callback?code=abc&state=forged', cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toMatch(/^http:\/\/web\.test\/admin\/connectors\?error=/);
  });

  it('unknown providers are a 400', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/oauth/dropbox/callback?code=a&state=b', cookies: { [COOKIE]: cookie } });
    expect(res.statusCode).toBe(400);
  });
});
