import { describe, expect, it } from 'vitest';
import { InMemoryIdentityAdmin, ZitadelAdmin, type IdentityAdmin } from '../src/zitadel.js';

/**
 * The IdentityAdmin contract, run against both implementations.
 *
 * The live half runs when ZITADEL_TEST_ISSUER and ZITADEL_TEST_PAT point at a real instance
 * (the local stack writes the PAT for its bootstrap machine user). It is skipped, loudly,
 * otherwise — never faked, because the point is to catch drift between Zitadel's API and ours.
 */

const liveIssuer = process.env['ZITADEL_TEST_ISSUER'];
const livePat = process.env['ZITADEL_TEST_PAT'];

const implementations: Array<[string, () => IdentityAdmin, boolean]> = [
  ['in-memory', () => new InMemoryIdentityAdmin(), true],
  [
    'zitadel (live)',
    () => new ZitadelAdmin({ issuer: liveIssuer ?? '', auth: { kind: 'pat', token: livePat ?? '' } }),
    Boolean(liveIssuer && livePat),
  ],
];

describe.each(implementations)('IdentityAdmin contract — %s', (_name, make, enabled) => {
  const suffix = Math.random().toString(36).slice(2, 8);

  it.runIf(enabled)('provisions an org per tenant, a human, and a DISTINCT machine user per agent', async () => {
    const admin = make();
    const { orgId } = await admin.createOrganization(`Contract Tenant ${suffix}`);
    expect(orgId).toBeTruthy();

    const human = await admin.createHumanUser({
      orgId,
      email: `owner-${suffix}@example.com`,
      givenName: 'Owner',
      familyName: 'Contract',
    });
    const agentA = await admin.createMachineUser({ orgId, username: `agent-a-${suffix}`, name: 'Agent A' });
    const agentB = await admin.createMachineUser({ orgId, username: `agent-b-${suffix}`, name: 'Agent B' });

    // module1.md §5.5: agents are principals in their own right, never aliases of a user.
    expect(new Set([human.userId, agentA.userId, agentB.userId]).size).toBe(3);

    const invite = await admin.createInviteCode(human.userId, { returnCode: true });
    expect(invite.code).toBeTruthy();

    await admin.deactivateUser(human.userId);
    await admin.reactivateUser(human.userId);
    await admin.deleteUser(agentB.userId);
    await admin.deleteOrganization(orgId);
    await expect(admin.deleteOrganization(orgId)).resolves.toBeUndefined();
  });

  it.runIf(enabled)('refuses a duplicate machine username within an org', async () => {
    const admin = make();
    const { orgId } = await admin.createOrganization(`Dup Tenant ${suffix}`);
    await admin.createMachineUser({ orgId, username: `dup-${suffix}`, name: 'Dup' });
    await expect(
      admin.createMachineUser({ orgId, username: `dup-${suffix}`, name: 'Dup' }),
    ).rejects.toThrow();
  });
});
