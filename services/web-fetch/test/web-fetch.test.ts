import { describe, expect, it } from 'vitest';
import { remoteBackend } from '@vega/connector-web';
import { buildWebFetchApp } from '../src/app.js';

/** The service applies safeFetch's checks; the network policy (infra/tests) is the second line. */

const injectFetch = (app: Awaited<ReturnType<typeof buildWebFetchApp>>) =>
  (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const res = await app.inject({ method: 'POST', url: url.pathname, payload: String(init?.body ?? ''), headers: { 'content-type': 'application/json' } });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

describe('web-fetch service', () => {
  it.each([['http://169.254.169.254/latest/meta-data/'], ['http://127.0.0.1:5432/'], ['http://metadata.google.internal/'], ['file:///etc/passwd']])(
    'refuses %s with 403 EGRESS_DENIED',
    async (url) => {
      const app = await buildWebFetchApp();
      const res = await app.inject({ method: 'POST', url: '/fetch', payload: { url } });
      if (url.startsWith('file:')) {
        expect([400, 403]).toContain(res.statusCode);
      } else {
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ error: { code: 'EGRESS_DENIED' } });
      }
    },
  );

  it('the execution plane’s remote backend maps refusals back to ToolErrors', async () => {
    const app = await buildWebFetchApp();
    const backend = remoteBackend('http://web-fetch.internal', injectFetch(app));
    await expect(backend.fetch('http://10.0.0.1/', 1000)).rejects.toMatchObject({ code: 'EGRESS_DENIED' });
  });

  it('search without a configured engine is CONNECTOR_UNAVAILABLE, not a crash', async () => {
    const saved = process.env['SEARXNG_URL'];
    delete process.env['SEARXNG_URL'];
    const app = await buildWebFetchApp();
    const res = await app.inject({ method: 'POST', url: '/search', payload: { query: 'x' } });
    if (saved !== undefined) process.env['SEARXNG_URL'] = saved;
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: 'CONNECTOR_UNAVAILABLE' } });
  });
});
