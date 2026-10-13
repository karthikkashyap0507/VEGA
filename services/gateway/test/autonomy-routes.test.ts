import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutonomyService } from '@vega/service-control';
import { COOKIE, createGatewayHarness, type GatewayHarness } from './harness.js';

/**
 * Module 10's public surface — docs/module10.md §16. What is proved here is the HTTP contract:
 * every path exists and is documented, needs a session, validates at the edge, and reaches the
 * control plane's own rules (who may do what is proved in the control-plane suite).
 */

let h: GatewayHarness;
let cookie: string;
let teamsCookie: string;

const PATHS = [
  '/v1/autonomy',
  '/v1/autonomy/{workflow}/{action}',
  '/v1/autonomy/certify',
  '/v1/autonomy/promote',
  '/v1/autonomy/demote',
  '/v1/autonomy/transitions',
  '/v1/autonomy/proposals',
  '/v1/autonomy/proposals/{id}/decide',
  '/v1/certifications/{id}',
  '/v1/certifications/{id}/report',
  '/v1/entities/{key}/activity',
  '/v1/locks',
  '/v1/locks/{id}/release',
  '/v1/contact-ledger',
  '/v1/contact-ledger/override',
  '/v1/write-conflicts',
  '/v1/write-conflicts/{id}/resolve',
  '/v1/usage',
  '/v1/budgets',
];

beforeAll(async () => {
  h = await createGatewayHarness({ controlDeps: { autonomy: new AutonomyService() } });
  const t = await h.tenant('business');
  cookie = (await h.signIn(t.subject)).cookie;
  const teams = await h.tenant('teams');
  teamsCookie = (await h.signIn(teams.subject)).cookie;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

const get = (url: string) => h.gateway.inject({ method: 'GET', url, cookies: { [COOKIE]: cookie } });
const send = (method: 'POST' | 'PUT', url: string, payload: unknown) => h.gateway.inject({ method, url, cookies: { [COOKIE]: cookie }, payload: payload as never });

describe('the §16 surface', () => {
  it('every path is registered and documented', async () => {
    const doc = await h.gateway.inject({ method: 'GET', url: '/v1/openapi.json' });
    const paths = Object.keys((doc.json() as { paths?: Record<string, unknown> }).paths ?? {});
    expect(paths).toEqual(expect.arrayContaining(PATHS));
  });

  it('all of it needs a session', async () => {
    for (const url of ['/v1/autonomy', '/v1/locks', '/v1/budgets', '/v1/usage', '/v1/write-conflicts', '/v1/contact-ledger']) {
      const res = await h.gateway.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
    const post = await h.gateway.inject({ method: 'POST', url: '/v1/autonomy/promote', payload: { certificationId: randomUUID() } });
    expect(post.statusCode).toBe(401);
  });
});

describe('budgets (P5)', () => {
  it('PUT then GET: the hard cap and its breach behavior round-trip', async () => {
    const first = await get('/v1/budgets');
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ breachBehavior: 'queue' });
    const put = await send('PUT', '/v1/budgets', { limitCents: 5000, breachBehavior: 'degrade' });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({ limitCents: 5000, breachBehavior: 'degrade', state: 'ok' });
    expect((await get('/v1/budgets')).json()).toMatchObject({ limitCents: 5000, breachBehavior: 'degrade' });
  });
  it('is validated at the edge: an unknown behavior or a negative cap is a 400 problem', async () => {
    for (const body of [{ limitCents: 100, breachBehavior: 'explode' }, { limitCents: -5, breachBehavior: 'halt' }, { breachBehavior: 'halt' }]) {
      const res = await send('PUT', '/v1/budgets', body);
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
  });
});

describe('the ladder', () => {
  it('lists (empty for a new tenant) and answers 404 for a pair that is not on the ladder', async () => {
    const list = await get('/v1/autonomy');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({ items: [] });
    const one = await get(`/v1/autonomy/${randomUUID()}/gmail.send`);
    expect([403, 404]).toContain(one.statusCode);
  });
  it('promotion is a plan surface (403 on a lower plan); on one that has it, an unknown certification is a 404', async () => {
    const lower = await send('POST', '/v1/autonomy/promote', { certificationId: randomUUID() });
    expect(lower.statusCode).toBe(403);
    expect(lower.json()).toMatchObject({ type: 'https://errors.vega.dev/entitlement-required' });
    const res = await h.gateway.inject({ method: 'POST', url: '/v1/autonomy/promote', cookies: { [COOKIE]: teamsCookie }, payload: { certificationId: randomUUID() } });
    expect(res.statusCode).toBe(404);
    // and there is no route that sets a tier directly
    for (const method of ['PUT', 'PATCH', 'POST'] as const) {
      const direct = await h.gateway.inject({ method, url: '/v1/autonomy/tier', cookies: { [COOKIE]: cookie }, payload: { tier: 'AUTONOMOUS' } });
      expect([404, 405]).toContain(direct.statusCode);
    }
  });
  it('demotion needs a reason, validated at the edge', async () => {
    const res = await send('POST', '/v1/autonomy/demote', { agentId: randomUUID(), toolId: 'gmail.send', to: 'SUSPENDED' });
    expect(res.statusCode).toBe(400);
    const tooShort = await send('POST', '/v1/autonomy/demote', { agentId: randomUUID(), toolId: 'gmail.send', to: 'SUSPENDED', reason: 'x' });
    expect(tooShort.statusCode).toBe(400);
  });
  it('an unknown certification report is a 404', async () => {
    expect((await get(`/v1/certifications/${randomUUID()}/report`)).statusCode).toBe(404);
  });
  it('a malformed id is a 400, not a 500', async () => {
    expect((await get('/v1/certifications/not-a-uuid')).statusCode).toBe(400);
  });
});

describe('contention', () => {
  it('"who else is on this account" accepts an entity key with a colon', async () => {
    const res = await get(`/v1/entities/${encodeURIComponent('crm:acct-42')}/activity`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ entityKey: 'crm:acct-42', holders: [], waiters: [] });
  });
  it('locks and conflicts list; a lock release and a contact override both need a reason', async () => {
    expect((await get('/v1/locks')).json()).toEqual({ items: [] });
    expect((await get('/v1/write-conflicts?status=open')).json()).toEqual({ items: [] });
    const release = await send('POST', `/v1/locks/${randomUUID()}/release`, {});
    expect(release.statusCode).toBe(400);
    const override = await send('POST', '/v1/contact-ledger/override', { identity: 'someone@example.com', runId: randomUUID() });
    expect(override.statusCode).toBe(400);
  });
  it('releasing a lock that does not exist is a 404', async () => {
    const res = await send('POST', `/v1/locks/${randomUUID()}/release`, { reason: 'stuck, confirmed with the owner' });
    expect(res.statusCode).toBe(404);
  });
});

describe('usage', () => {
  it('answers for every dimension; a bad dimension is a 400', async () => {
    for (const by of ['user', 'agent', 'workflow', 'connector', 'model']) {
      const res = await get(`/v1/usage?by=${by}`);
      expect(res.statusCode, by).toBe(200);
      expect(res.json()).toMatchObject({ rows: [], totals: { runs: 0 } });
    }
    expect((await get('/v1/usage?by=planet')).statusCode).toBe(400);
  });
});
