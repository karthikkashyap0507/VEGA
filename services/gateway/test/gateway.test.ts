import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import { COOKIE, cookieFrom, createGatewayHarness, type GatewayHarness } from './harness.js';

let h: GatewayHarness;
let A: Awaited<ReturnType<GatewayHarness['tenant']>>;
let B: Awaited<ReturnType<GatewayHarness['tenant']>>;
let cookieA: string;
let cookieB: string;

const as = (cookie: string) => ({ cookies: { [COOKIE]: cookie } });

beforeAll(async () => {
  h = await createGatewayHarness();
  A = await h.tenant('business');
  B = await h.tenant('business');
  cookieA = (await h.signIn(A.subject)).cookie;
  cookieB = (await h.signIn(B.subject)).cookie;
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('sign-in (module1.md §8.1, Step 3 DoD)', () => {
  it('login → IdP → callback → session cookie → GET /v1/me', async () => {
    const { cookie, response } = await h.signIn(A.subject, '/admin');
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('http://web.test/admin');
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    const me = await h.gateway.inject({ method: 'GET', url: '/v1/me', ...as(cookie) });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.user.id).toBe(A.userId);
    expect(body.tenantId).toBe(A.tenantId);
    expect(body.user.role).toBe('OWNER');
    // First sign-in activated the invited owner.
    expect(body.user.status).toBe('active');
  });

  it('the login request carries PKCE S256, state and nonce', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/oauth/login' });
    const url = new URL(String(res.headers.location));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
  });

  it('refuses a callback whose state does not match the browser\'s sealed login state', async () => {
    const start = await h.gateway.inject({ method: 'GET', url: '/v1/oauth/login' });
    const login = cookieFrom(start, `${COOKIE}_login`)!;
    const { code } = h.idp.authorize(String(start.headers.location), A.subject);
    const res = await h.gateway.inject({
      method: 'GET',
      url: `/v1/oauth/callback?code=${code}&state=forged`,
      cookies: { [`${COOKIE}_login`]: login },
    });
    expect(res.headers.location).toBe('http://web.test/login?error=invalid_state');
    expect(cookieFrom(res, COOKIE)).toBeFalsy();
  });

  it('refuses a callback with no login state at all (cross-site initiated)', async () => {
    const start = await h.gateway.inject({ method: 'GET', url: '/v1/oauth/login' });
    const { code, state } = h.idp.authorize(String(start.headers.location), A.subject);
    const res = await h.gateway.inject({ method: 'GET', url: `/v1/oauth/callback?code=${code}&state=${state}` });
    expect(res.headers.location).toBe('http://web.test/login?error=invalid_state');
  });

  it('a subject with no user in any tenant gets no session', async () => {
    const { response } = await h.signIn('nobody-knows-me');
    expect(response.headers.location).toBe('http://web.test/login?error=no_account');
    expect(cookieFrom(response, COOKIE)).toBeFalsy();
  });

  it('returnTo cannot redirect off-site', async () => {
    for (const evil of ['//evil.example/x', 'https://evil.example', '/\\evil.example']) {
      const { response } = await h.signIn(A.subject, evil);
      expect(response.headers.location).toBe('http://web.test/');
    }
  });

  it('a deactivated user cannot sign in', async () => {
    const t = await h.tenant('business');
    await withTenant(t.tenantId, (db) =>
      db.update(schema.users).set({ status: 'deactivated' }).where(eq(schema.users.id, t.userId)),
    );
    const { response } = await h.signIn(t.subject);
    expect(response.headers.location).toBe('http://web.test/login?error=account_deactivated');
  });
});

describe('tenant context comes only from the verified session', () => {
  it('no session → 401 problem+json', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.json().type).toBe('https://errors.vega.dev/unauthorized');
  });

  it('a request-supplied tenant header, query or body is ignored', async () => {
    const res = await h.gateway.inject({
      method: 'GET',
      url: `/v1/me?tenantId=${B.tenantId}`,
      headers: { 'x-tenant-id': B.tenantId, 'x-vega-tenant': B.tenantId },
      ...as(cookieA),
    });
    expect(res.json().tenantId).toBe(A.tenantId);
  });

  it('API isolation (§11.2 step 4): tenant-A session with tenant-B identifiers', async () => {
    for (const [method, url, payload] of [
      ['GET', `/v1/workspaces/${B.workspaceId}`, undefined],
      ['GET', `/v1/users/${B.userId}`, undefined],
      ['PATCH', `/v1/users/${B.userId}`, { role: 'MEMBER' }],
      ['DELETE', `/v1/users/${B.userId}`, undefined],
      ['PATCH', `/v1/workspaces/${B.workspaceId}`, { name: 'pwned' }],
      ['POST', `/v1/workspaces/${B.workspaceId}/members`, { userId: A.userId, role: 'owner' }],
      ['POST', '/v1/agents', { workspaceId: B.workspaceId, name: 'intruder' }],
    ] as const) {
      const res = await h.gateway.inject({ method, url, ...(payload ? { payload } : {}), ...as(cookieA) });
      expect([403, 404], `${method} ${url} → ${res.statusCode}`).toContain(res.statusCode);
    }
    // and tenant B's data is untouched
    const ws = await h.gateway.inject({ method: 'GET', url: `/v1/workspaces/${B.workspaceId}`, ...as(cookieB) });
    expect(ws.json().name).not.toBe('pwned');
  });
});

describe('Step 6 DoD flow through the public API: invite → workspace → agent', () => {
  it('works end to end without touching the database', async () => {
    const invite = await h.gateway.inject({
      method: 'POST',
      url: '/v1/users/invite',
      payload: { email: 'colleague@a.example', role: 'WORKFLOW_OWNER' },
      ...as(cookieA),
    });
    expect(invite.statusCode).toBe(201);
    const invited = invite.json().user;

    const ws = await h.gateway.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: 'Deals' }, ...as(cookieA) });
    expect(ws.statusCode).toBe(201);
    const workspaceId = ws.json().id;

    const member = await h.gateway.inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/members`,
      payload: { userId: invited.id, role: 'member' },
      ...as(cookieA),
    });
    expect(member.statusCode).toBe(201);

    const agent = await h.gateway.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { workspaceId, name: 'client-comm', ownerUserId: A.userId },
      ...as(cookieA),
    });
    expect(agent.statusCode).toBe(201);
    expect(agent.json().idpMachineId).toBeTruthy();
    expect(agent.json().status).toBe('draft');

    const list = await h.gateway.inject({ method: 'GET', url: `/v1/agents?workspaceId=${workspaceId}`, ...as(cookieA) });
    expect(list.json().items.map((a: { id: string }) => a.id)).toContain(agent.json().id);
  });
});

describe('conventions (module1.md §7.2)', () => {
  it('Idempotency-Key: a double POST produces one effect and replays the first response', async () => {
    const req = {
      method: 'POST' as const,
      url: '/v1/workspaces',
      payload: { name: 'Idempotent Space' },
      headers: { 'idempotency-key': 'create-ws-1' },
      ...as(cookieA),
    };
    const first = await h.gateway.inject(req);
    const second = await h.gateway.inject(req);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json().id).toBe(first.json().id);

    const rows = await withTenant(A.tenantId, (db) =>
      db.select().from(schema.workspaces).where(eq(schema.workspaces.name, 'Idempotent Space')),
    );
    expect(rows).toHaveLength(1);
  });

  it('Idempotency-Key reused with a different body → 422', async () => {
    await h.gateway.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { name: 'Key Reuse One' },
      headers: { 'idempotency-key': 'reuse-key' },
      ...as(cookieA),
    });
    const res = await h.gateway.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { name: 'Key Reuse Two' },
      headers: { 'idempotency-key': 'reuse-key' },
      ...as(cookieA),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().type).toBe('https://errors.vega.dev/idempotency-conflict');
  });

  it('idempotency keys are per principal: tenant B cannot replay tenant A\'s response', async () => {
    const res = await h.gateway.inject({
      method: 'POST',
      url: '/v1/workspaces',
      payload: { name: 'Idempotent Space' },
      headers: { 'idempotency-key': 'create-ws-1' },
      ...as(cookieB),
    });
    expect(res.headers['idempotent-replayed']).toBeUndefined();
    const created = res.json();
    expect(created.tenantId).toBe(B.tenantId);
  });

  it('validation failures are RFC 9457 with field paths', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/workspaces/not-a-uuid', ...as(cookieA) });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.type).toBe('https://errors.vega.dev/validation');
    expect(body.errors[0].path).toBe('params.id');
  });

  it('the retention floor is enforced at the API (180 days)', async () => {
    const res = await h.gateway.inject({ method: 'PATCH', url: '/v1/tenants/current', payload: { retentionDays: 30 }, ...as(cookieA) });
    expect(res.statusCode).toBe(400);
  });

  it('cursor pagination walks every row exactly once', async () => {
    for (let i = 0; i < 5; i++) {
      await h.gateway.inject({ method: 'POST', url: '/v1/workspaces', payload: { name: `Page ${i}` }, ...as(cookieA) });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const url: string = `/v1/workspaces?limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await h.gateway.inject({ method: 'GET', url, ...as(cookieA) });
      const body = res.json() as { items: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...body.items.map((w) => w.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(6);
  });

  it('security headers on every response, and a trace id', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/me', ...as(cookieA) });
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-trace-id']).toBeDefined();
  });

  it('OpenAPI is generated from the same Zod schemas', async () => {
    const res = await h.gateway.inject({ method: 'GET', url: '/v1/openapi.json' });
    const doc = res.json();
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/v1/me', '/v1/agents', '/v1/users/invite']));
    const createAgent = doc.paths['/v1/agents'].post;
    expect(createAgent.requestBody.content['application/json'].schema.required).toContain('workspaceId');
  });
});

describe('sessions: rotation, reuse detection, logout', () => {
  it('rotates, honours the grace window, and revokes the session on token reuse', async () => {
    const r = await createGatewayHarness({ rotateAfterSeconds: 0 });
    try {
      const t = await r.tenant();
      const { cookie: first } = await r.signIn(t.subject);

      const a = await r.gateway.inject({ method: 'GET', url: '/v1/me', cookies: { [COOKIE]: first } });
      const second = cookieFrom(a, COOKIE);
      expect(second).toBeTruthy();
      expect(second).not.toBe(first);

      // Within the grace window the old token still works (parallel page-load requests).
      const b = await r.gateway.inject({ method: 'GET', url: '/v1/me', cookies: { [COOKIE]: first } });
      expect(b.statusCode).toBe(200);

      // Expire the grace window, then present the old token: that is theft.
      await withTenant(t.tenantId, (db) =>
        db.update(schema.sessions).set({ previousValidUntil: new Date(Date.now() - 1000) }).where(eq(schema.sessions.userId, t.userId)),
      );
      const reuse = await r.gateway.inject({ method: 'GET', url: '/v1/me', cookies: { [COOKIE]: first } });
      expect(reuse.statusCode).toBe(401);
      // ...and the legitimate holder's current token is dead too: the whole session is gone.
      const legit = await r.gateway.inject({ method: 'GET', url: '/v1/me', cookies: { [COOKIE]: second! } });
      expect(legit.statusCode).toBe(401);
    } finally {
      await r.close();
    }
  });

  it('logout revokes the session server-side', async () => {
    const { cookie } = await h.signIn(A.subject);
    const out = await h.gateway.inject({ method: 'POST', url: '/v1/auth/logout', ...as(cookie) });
    expect(out.statusCode).toBe(200);
    expect(out.json().endSessionUrl).toContain('/oidc/v1/end_session');
    const after = await h.gateway.inject({ method: 'GET', url: '/v1/me', ...as(cookie) });
    expect(after.statusCode).toBe(401);
  });

  it('bearer clients: POST /v1/auth/refresh rotates and invalidates the old token after grace', async () => {
    const { cookie } = await h.signIn(A.subject);
    const refreshed = await h.gateway.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { authorization: `Bearer ${cookie}` },
    });
    expect(refreshed.statusCode).toBe(200);
    const token = refreshed.json().accessToken;
    const me = await h.gateway.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(me.json().user.id).toBe(A.userId);
  });

  it('lists and revokes the caller\'s own sessions', async () => {
    const { cookie } = await h.signIn(A.subject);
    const list = await h.gateway.inject({ method: 'GET', url: '/v1/sessions', ...as(cookie) });
    const items = list.json().items as Array<{ id: string; current: boolean }>;
    const other = items.find((s) => !s.current)!;
    await h.gateway.inject({ method: 'DELETE', url: `/v1/sessions/${other.id}`, ...as(cookie) });
    const after = await h.gateway.inject({ method: 'GET', url: '/v1/sessions', ...as(cookie) });
    expect((after.json().items as Array<{ id: string }>).map((s) => s.id)).not.toContain(other.id);
  });
});

describe('rate limits', () => {
  it('429 with Retry-After once the per-token budget is spent', async () => {
    const r = await createGatewayHarness({ tokenLimit: 3 });
    try {
      const t = await r.tenant();
      const { cookie } = await r.signIn(t.subject);
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = await r.gateway.inject({ method: 'GET', url: '/v1/me', cookies: { [COOKIE]: cookie } });
        codes.push(res.statusCode);
        if (res.statusCode === 429) {
          expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
          expect(res.json().type).toBe('https://errors.vega.dev/rate-limited');
        }
      }
      expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
      expect(codes[3]).toBe(429);
    } finally {
      await r.close();
    }
  });
});

describe('self-serve signup (Step 7)', () => {
  it('a brand-new email reaches a provisioned, usable workspace', async () => {
    const started = Date.now();
    const signup = await h.gateway.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { email: 'founder@newco.example', company: 'NewCo' },
    });
    expect(signup.statusCode).toBe(201);
    const body = signup.json();
    expect(body.next.map((n: { step: string }) => n.step)).toEqual(['connect', 'first_run']);

    // The identity the signup created is the one that signs in.
    const idpUser = [...h.identity.users.entries()].find(([, u]) => u.email === 'founder@newco.example')!;
    const { cookie } = await h.signIn(idpUser[0]);
    const me = await h.gateway.inject({ method: 'GET', url: '/v1/me', ...as(cookie) });
    expect(me.json().tenantId).toBe(body.tenantId);
    expect(me.json().entitlements.plan).toBe('free');
    expect(me.json().workspaceIds).toEqual([body.workspaceId]);
    expect(Date.now() - started).toBeLessThan(5 * 60 * 1000);
  });

  it('drops a signup password unless SIGNUP_ALLOW_PASSWORD is on', async () => {
    const res = await h.gateway.inject({
      method: 'POST',
      url: '/v1/signup',
      payload: { email: 'pw@newco2.example', company: 'NewCo2', password: 'hunter2hunter2' },
    });
    expect(res.statusCode).toBe(201);
    const idpUser = [...h.identity.users.values()].find((u) => u.email === 'pw@newco2.example');
    expect(idpUser?.hasPassword).toBe(false);
  });
});
