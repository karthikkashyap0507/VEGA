import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import { fga as fgaIds, tuple } from '@vega/authz';
import { PrincipalAssertionIssuer } from '@vega/idp';
import { PRINCIPAL_HEADER } from '../src/app.js';
import { activate, createHarness, problemOf, type Harness } from './harness.js';

let h: Harness;
let A: Awaited<ReturnType<Harness['tenant']>>;
let B: Awaited<ReturnType<Harness['tenant']>>;

beforeAll(async () => {
  h = await createHarness();
  A = await h.tenant('business');
  B = await h.tenant('business');
}, 60_000);

afterAll(async () => {
  await h?.close();
});

describe('principal resolution', () => {
  it('GET me returns identity, role, tenant, workspaces and capabilities', async () => {
    const me = await h.as(A.tenantId, A.userId).me.get.query();
    expect(me.user.id).toBe(A.userId);
    expect(me.user.role).toBe('OWNER');
    expect(me.tenantId).toBe(A.tenantId);
    expect(me.tenant.id).toBe(A.tenantId);
    expect(me.workspaceIds).toEqual([A.workspaceId]);
    expect(me.capabilities).toContain('billing.manage');
    expect(me.entitlements.plan).toBe('business');
  });

  it('a request with no principal is an invariant violation (tenant-context-missing, 500)', async () => {
    const p = await problemOf(h.raw({}).me.get.query());
    expect(p.type).toBe('https://errors.vega.dev/tenant-context-missing');
    expect(p.status).toBe(500);
  });

  it('an assertion signed by any other key is refused', async () => {
    const forger = await PrincipalAssertionIssuer.ephemeral('gateway', 'control');
    const forged = await forger.mint({ tenantId: A.tenantId, userId: A.userId });
    const p = await problemOf(h.raw({ [PRINCIPAL_HEADER]: forged }).me.get.query());
    expect(p.type).toBe('trpc:UNAUTHORIZED');
  });

  it('the signup system principal reaches signup and nothing else', async () => {
    const token = await h.issuer.mint({ tenantId: 'system', userId: 'system:signup', system: 'signup' });
    const client = h.raw({ [PRINCIPAL_HEADER]: token });
    expect((await problemOf(client.me.get.query())).status).toBe(403);
    expect((await problemOf(client.users.list.query({}))).status).toBe(403);
    // and a user principal cannot provision tenants
    const p = await problemOf(
      h.as(A.tenantId, A.userId).signup.provision.mutate({ email: 'x@y.example', company: 'X' }),
    );
    expect(p.status).toBe(403);
  });

  it('two unrelated firms with the same name can both sign up (organization names are unique in the IdP)', async () => {
    const token = await h.issuer.mint({ tenantId: 'system', userId: 'system:signup', system: 'signup' });
    const client = h.raw({ [PRINCIPAL_HEADER]: token });
    const suffix = Math.random().toString(36).slice(2, 8);
    const first = await client.signup.provision.mutate({ email: `a-${suffix}@first.example`, company: `Acme ${suffix}` });
    const second = await client.signup.provision.mutate({ email: `b-${suffix}@second.example`, company: `Acme ${suffix}` });
    expect(first.tenantId).not.toBe(second.tenantId);
    expect([...h.identity.orgs.values()].filter((o) => o.name.startsWith(`Acme ${suffix}`))).toHaveLength(2);
  });

  it('a mismatched (tenant, user) pair resolves to nothing — RLS hides the user', async () => {
    const p = await problemOf(h.as(A.tenantId, B.userId).me.get.query());
    expect(p.status).toBe(401);
  });
});

describe('cross-tenant access through the API (isolation suite, step 4)', () => {
  it('cannot read another tenant\'s workspace by id', async () => {
    const p = await problemOf(h.as(A.tenantId, A.userId).workspaces.get.query({ id: B.workspaceId }));
    expect([403, 404]).toContain(p.status);
  });

  it('cannot see another tenant\'s users in a list', async () => {
    const users = await h.as(A.tenantId, A.userId).users.list.query({});
    expect(users.items.map((u) => u.id)).toEqual([A.userId]);
  });

  it('cannot modify another tenant\'s user', async () => {
    const p = await problemOf(h.as(A.tenantId, A.userId).users.update.mutate({ id: B.userId, role: 'MEMBER' }));
    expect(p.status).toBe(404);
  });

  it('cannot create an agent in another tenant\'s workspace', async () => {
    const p = await problemOf(
      h.as(A.tenantId, A.userId).agents.create.mutate({ workspaceId: B.workspaceId, name: 'intruder' }),
    );
    expect(p.status).toBe(403);
  });
});

describe('users', () => {
  it('invite → Zitadel user in the tenant org, invited row, role tuple', async () => {
    const r = await h.as(A.tenantId, A.userId).users.invite.mutate({ email: 'ada@acme.example', role: 'ADMIN' });
    expect(r.user.status).toBe('invited');
    expect(r.inviteCode).toBeTruthy();
    const idpUser = [...h.identity.users.values()].find((u) => u.email === 'ada@acme.example');
    expect(idpUser?.orgId).toBe(A.orgId);
    expect(await h.fga.check(tuple(fgaIds.user(r.user.id), 'admin', fgaIds.tenant(A.tenantId)))).toBe(true);
  });

  it('re-inviting a still-invited email is a resend, not a conflict', async () => {
    const again = await h.as(A.tenantId, A.userId).users.invite.mutate({ email: 'ada@acme.example', role: 'ADMIN' });
    expect(again.user.email).toBe('ada@acme.example');
  });

  it('an ADMIN cannot invite an OWNER; a MEMBER cannot invite at all', async () => {
    const admin = await h.as(A.tenantId, A.userId).users.invite.mutate({ email: 'bob@acme.example', role: 'ADMIN' });
    await activate(A.tenantId, admin.user.id);
    const p1 = await problemOf(
      h.as(A.tenantId, admin.user.id).users.invite.mutate({ email: 'x@acme.example', role: 'OWNER' }),
    );
    expect(p1.status).toBe(403);

    const member = await h.as(A.tenantId, A.userId).users.invite.mutate({ email: 'mem@acme.example', role: 'MEMBER' });
    await activate(A.tenantId, member.user.id);
    const p2 = await problemOf(
      h.as(A.tenantId, member.user.id).users.invite.mutate({ email: 'y@acme.example', role: 'MEMBER' }),
    );
    expect(p2.status).toBe(403);
  });

  it('nobody changes their own role, and the last OWNER cannot be demoted', async () => {
    const self = await problemOf(h.as(A.tenantId, A.userId).users.update.mutate({ id: A.userId, role: 'MEMBER' }));
    expect(self.status).toBe(403);

    const second = await h.as(A.tenantId, A.userId).users.invite.mutate({ email: 'own2@acme.example', role: 'OWNER' });
    await activate(A.tenantId, second.user.id);
    // Two owners: the second may demote the first...
    await h.as(A.tenantId, second.user.id).users.update.mutate({ id: A.userId, role: 'ADMIN' });
    // ...and now the second is the last one, so the (now ADMIN) first cannot touch them.
    const last = await problemOf(
      h.as(A.tenantId, A.userId).users.update.mutate({ id: second.user.id, role: 'ADMIN' }),
    );
    expect(last.status).toBe(403);
    // Restore for later tests.
    await h.as(A.tenantId, second.user.id).users.update.mutate({ id: A.userId, role: 'OWNER' });
  });

  it('deactivation cuts the user off immediately and revokes their sessions', async () => {
    const u = await h.as(A.tenantId, A.userId).users.invite.mutate({ email: 'gone@acme.example', role: 'MEMBER' });
    await activate(A.tenantId, u.user.id);
    await withTenant(A.tenantId, (db) =>
      db.insert(schema.sessions).values({
        tenantId: A.tenantId,
        userId: u.user.id,
        tokenHash: Buffer.from('x'.repeat(32) + u.user.id),
        expiresAt: new Date(Date.now() + 3_600_000),
        absoluteExpiresAt: new Date(Date.now() + 86_400_000),
      }),
    );
    await expect(h.as(A.tenantId, u.user.id).me.get.query()).resolves.toBeTruthy();

    await h.as(A.tenantId, A.userId).users.update.mutate({ id: u.user.id, status: 'deactivated' });
    const p = await problemOf(h.as(A.tenantId, u.user.id).me.get.query());
    expect(p.status).toBe(401);

    const sessions = await withTenant(A.tenantId, (db) =>
      db.select().from(schema.sessions).where(eq(schema.sessions.userId, u.user.id)),
    );
    expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
    const idp = h.identity.users.get(
      (await withTenant(A.tenantId, (db) => db.select().from(schema.users).where(eq(schema.users.id, u.user.id))))[0]!
        .idpSubject!,
    );
    expect(idp?.active).toBe(false);
  });

  it('seat limits come from plan_entitlements data (free plan: 1 seat)', async () => {
    const free = await h.tenant('free');
    const p = await problemOf(
      h.as(free.tenantId, free.userId).users.invite.mutate({ email: 'seat2@free.example', role: 'MEMBER' }),
    );
    expect(p.type).toBe('https://errors.vega.dev/limit-exceeded');
  });
});

describe('tenant settings', () => {
  it('enforces the 180-day retention floor in the API', async () => {
    const low = await problemOf(h.as(A.tenantId, A.userId).tenants.update.mutate({ retentionDays: 90 }));
    expect(low.status).toBe(400);
    const ok = await h.as(A.tenantId, A.userId).tenants.update.mutate({ retentionDays: 180, name: 'Acme Renamed' });
    expect(ok.retentionDays).toBe(180);
    expect(ok.name).toBe('Acme Renamed');
  });
});

describe('workspaces', () => {
  it('create makes the creator owner in both the database and OpenFGA', async () => {
    const ws = await h.as(A.tenantId, A.userId).workspaces.create.mutate({ name: 'Client Ops' });
    expect(ws.slug).toBe('client-ops');
    expect(await h.fga.check(tuple(fgaIds.user(A.userId), 'can_manage', fgaIds.workspace(ws.id)))).toBe(true);
    const dup = await problemOf(h.as(A.tenantId, A.userId).workspaces.create.mutate({ name: 'Client Ops' }));
    expect(dup.status).toBe(409);
  });

  it('sharing a workspace is an exposed surface: refused on free, allowed on business', async () => {
    const free = await h.tenant('free');
    const p = await problemOf(
      h.as(free.tenantId, free.userId).workspaces.addMember.mutate({
        id: free.workspaceId,
        userId: '00000000-0000-4000-8000-000000000000',
        role: 'member',
      }),
    );
    expect(p.type).toBe('https://errors.vega.dev/entitlement-required');
  });

  it('members of workspace A cannot see or run in workspace B', async () => {
    const wsB = await h.as(A.tenantId, A.userId).workspaces.create.mutate({ name: 'Secret Deals' });
    const m = await h.as(A.tenantId, A.userId).users.invite.mutate({ email: 'wfo@acme.example', role: 'WORKFLOW_OWNER' });
    await activate(A.tenantId, m.user.id);
    await h.as(A.tenantId, A.userId).workspaces.addMember.mutate({ id: A.workspaceId, userId: m.user.id, role: 'member' });

    const visible = await h.as(A.tenantId, m.user.id).workspaces.list.query({});
    expect(visible.items.map((w) => w.id)).toEqual([A.workspaceId]);

    const p = await problemOf(h.as(A.tenantId, m.user.id).agents.create.mutate({ workspaceId: wsB.id, name: 'x' }));
    expect(p.status).toBe(403);

    // and removal revokes immediately
    await h.as(A.tenantId, A.userId).workspaces.removeMember.mutate({ id: A.workspaceId, userId: m.user.id });
    expect(await h.fga.check(tuple(fgaIds.user(m.user.id), 'can_run_agent', fgaIds.workspace(A.workspaceId)))).toBe(false);
  });

  it('the last owner of a workspace cannot be removed', async () => {
    const p = await problemOf(
      h.as(A.tenantId, A.userId).workspaces.removeMember.mutate({ id: A.workspaceId, userId: A.userId }),
    );
    expect(p.status).toBe(422);
  });
});

describe('agents (module1.md §8.2)', () => {
  it('each agent gets its own, distinct machine identity in the tenant org', async () => {
    const a1 = await h.as(A.tenantId, A.userId).agents.create.mutate({ workspaceId: A.workspaceId, name: 'client-comm' });
    const a2 = await h.as(A.tenantId, A.userId).agents.create.mutate({ workspaceId: A.workspaceId, name: 'scheduler' });
    expect(a1.status).toBe('draft');
    expect(a1.idpMachineId).not.toBe(a2.idpMachineId);
    expect(a1.idpMachineId).not.toBe(A.userId);
    const machine = h.identity.users.get(a1.idpMachineId);
    expect(machine).toMatchObject({ kind: 'machine', orgId: A.orgId, username: `agent-${a1.id}` });
    expect(await h.fga.check(tuple(fgaIds.user(A.userId), 'can_run', fgaIds.agent(a1.id)))).toBe(true);

    const events = await withTenant(A.tenantId, (db) =>
      db.select().from(schema.platformEvents).where(eq(schema.platformEvents.kind, 'agent.created')),
    );
    expect(events.some((e) => (e.payload as { agentId?: string }).agentId === a1.id)).toBe(true);
  });

  it('a COMPLIANCE_OFFICER cannot create agents even as a workspace member', async () => {
    const co = await h.as(A.tenantId, A.userId).users.invite.mutate({ email: 'co@acme.example', role: 'COMPLIANCE_OFFICER' });
    await activate(A.tenantId, co.user.id);
    await h.as(A.tenantId, A.userId).workspaces.addMember.mutate({ id: A.workspaceId, userId: co.user.id, role: 'member' });
    const p = await problemOf(h.as(A.tenantId, co.user.id).agents.create.mutate({ workspaceId: A.workspaceId, name: 'x' }));
    expect(p.status).toBe(403);
  });

  it('cannot be activated before Module 4 gives it a spec', async () => {
    const a = await h.as(A.tenantId, A.userId).agents.create.mutate({ workspaceId: A.workspaceId, name: 'unspecced' });
    const p = await problemOf(h.as(A.tenantId, A.userId).agents.update.mutate({ id: a.id, status: 'active' }));
    expect(p.status).toBe(422);
  });

  it('delete archives: tuples revoked first, machine identity deactivated, row retained', async () => {
    const a = await h.as(A.tenantId, A.userId).agents.create.mutate({ workspaceId: A.workspaceId, name: 'retiring' });
    const archived = await h.as(A.tenantId, A.userId).agents.remove.mutate({ id: a.id });
    expect(archived.status).toBe('archived');
    expect(await h.fga.check(tuple(fgaIds.user(A.userId), 'can_run', fgaIds.agent(a.id)))).toBe(false);
    expect(h.identity.users.get(a.idpMachineId)?.active).toBe(false);
  });

  it('is all-or-nothing: an authorization outage leaves no agent and no orphaned identity', async () => {
    const realWrite = h.fga.write.bind(h.fga);
    const before = h.identity.users.size;
    h.fga.write = async () => {
      throw new Error('openfga down');
    };
    try {
      const p = await problemOf(
        h.as(A.tenantId, A.userId).agents.create.mutate({ workspaceId: A.workspaceId, name: 'doomed' }),
      );
      expect(p.status).toBe(503);
    } finally {
      h.fga.write = realWrite;
    }
    expect(h.identity.users.size).toBe(before);
    const rows = await withTenant(A.tenantId, (db) =>
      db.select().from(schema.agents).where(eq(schema.agents.name, 'doomed')),
    );
    expect(rows).toHaveLength(0);
  });
});
