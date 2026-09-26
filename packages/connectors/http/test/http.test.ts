import { describe, expect, it } from 'vitest';
import { ProviderHttp, type ToolContext } from '@vega/connector-sdk';
import { request } from '../src/index.js';
import { isPublicAddressLike } from '../src/deps.js';

/** docs/module2.md §10.4: exact-origin allowlist, reserved addresses refused even when listed. */

function ctx(allowlist: string[], calls: string[] = []): ToolContext {
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    tenantId: 't',
    connectorId: 'c',
    internalDomains: [],
    config: { allowlist },
    http: new ProviderHttp({ baseUrl: 'https://invalid.example', fetchImpl }),
  };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as { code: string }).code;
  }
  return 'ALLOWED';
}

describe('http.request', () => {
  const allowed = ['https://api.corp.example', 'http://10.20.0.5:8080'];

  it('calls an allowlisted origin', async () => {
    const calls: string[] = [];
    const out = await request.execute({ method: 'GET', url: 'https://api.corp.example/v1/orders?x=1', headers: {} }, ctx(allowed, calls));
    expect(out.effect.detail.status).toBe(200);
    expect(calls).toEqual(['https://api.corp.example/v1/orders?x=1']);
  });

  it('allows an allowlisted private-range API (internal APIs are the point)', async () => {
    expect(await code(request.execute({ method: 'POST', url: 'http://10.20.0.5:8080/hook', headers: {} }, ctx(allowed)))).toBe('ALLOWED');
  });

  it.each([
    ['https://api.corp.example.attacker.com/'], // suffix trick
    ['https://evil.com/?https://api.corp.example'],
    ['http://api.corp.example/'], // scheme is part of the origin
    ['https://api.corp.example:8443/'], // so is the port
    ['https://sub.api.corp.example/'], // no wildcards
    ['http://10.20.0.5:8081/'],
  ])('refuses %s (not an exact origin match)', async (url) => {
    const calls: string[] = [];
    expect(await code(request.execute({ method: 'GET', url, headers: {} }, ctx(allowed, calls)))).toBe('EGRESS_DENIED');
    expect(calls).toEqual([]);
  });

  it('refuses metadata and loopback even when an admin allowlisted them', async () => {
    const bad = ['http://169.254.169.254', 'http://127.0.0.1:9000', 'http://localhost', 'http://[::1]', 'http://metadata.google.internal'];
    for (const origin of bad) {
      const url = new URL(origin).origin + '/';
      expect(await code(request.execute({ method: 'GET', url, headers: {} }, ctx([new URL(origin).origin])))).toBe('EGRESS_DENIED');
    }
  });

  it('strips hop-by-hop and credential headers', async () => {
    let seen: Headers | undefined;
    const c = ctx(allowed);
    c.http = new ProviderHttp({
      baseUrl: 'https://invalid.example',
      
      fetchImpl: (async (_u: string, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return new Response(null, { status: 204 });
      }) as typeof fetch,
    });
    await request.execute({ method: 'GET', url: 'https://api.corp.example/', headers: { Cookie: 'a=b', Host: 'x', 'X-Trace': '1' } }, c);
    expect(seen?.get('cookie')).toBeNull();
    expect(seen?.get('host')).toBeNull();
    expect(seen?.get('x-trace')).toBe('1');
  });

  it('simulates as DECLARED and names the destination as an external recipient', async () => {
    const sim = await request.simulate({ method: 'DELETE', url: 'https://api.corp.example/v1/orders/9', headers: {} }, ctx(allowed));
    expect(sim.fidelity).toBe('DECLARED');
    expect(sim.externalRecipients).toEqual(['https://api.corp.example']);
  });

  it('classifies reserved hosts', () => {
    expect(isPublicAddressLike('10.0.0.1')).toBe(true);
    expect(isPublicAddressLike('[::ffff:7f00:1]')).toBe(false);
    expect(isPublicAddressLike('[::ffff:a9fe:a9fe]')).toBe(false);
    expect(isPublicAddressLike('0.0.0.0')).toBe(false);
  });
});
