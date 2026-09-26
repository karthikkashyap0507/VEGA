import { beforeAll, describe, expect, it } from 'vitest';
import {
  FgaClient,
  agentCreatedTuples,
  fga,
  fgaAdmin,
  modelToJson,
  tenantRoleTuples,
  tuple,
  workspaceCreatedTuples,
  workspaceMemberTuples,
  type Role,
  type TupleKey,
} from '../src/index.js';

/**
 * OpenFGA ASSERTION TESTS — the Step 4 definition of done:
 *   "assertion tests pass for every role × relation; a member of workspace A cannot
 *    can_run_agent in workspace B."
 *
 * Runs against a real OpenFGA (the local stack, or the CI service container) with a fresh
 * store per run. The model under test is the checked-in DSL, so a model edit that changes
 * an answer fails here before it reaches a deployment.
 */

const API = process.env['OPENFGA_API_URL'] ?? 'http://localhost:8081';

let client: FgaClient;

const T = 'tenant-1';
const OTHER_T = 'tenant-2';
const WS_A = 'ws-a';
const WS_B = 'ws-b';
const AGENT_A = 'agent-a';

const U: Record<Role, string> = {
  OWNER: 'u-owner',
  ADMIN: 'u-admin',
  COMPLIANCE_OFFICER: 'u-compliance',
  WORKFLOW_OWNER: 'u-wfo',
  APPROVER: 'u-approver',
  MEMBER: 'u-member',
  AUDITOR: 'u-auditor',
};
const OUTSIDER = 'u-outsider'; // admin of a different tenant

beforeAll(async () => {
  const storeId = await fgaAdmin.createStore({ apiUrl: API }, `authz-test-${Date.now()}`);
  const modelId = await fgaAdmin.writeModel({ apiUrl: API }, storeId, modelToJson());
  client = new FgaClient({ apiUrl: API, storeId, modelId });

  const writes: TupleKey[] = [];
  for (const [role, userId] of Object.entries(U) as Array<[Role, string]>) {
    writes.push(tenantRoleTuples(T, userId, role).current);
  }
  writes.push(tenantRoleTuples(OTHER_T, OUTSIDER, 'ADMIN').current);

  writes.push(...workspaceCreatedTuples({ workspaceId: WS_A, tenantId: T, ownerUserId: U.OWNER }));
  writes.push(...workspaceCreatedTuples({ workspaceId: WS_B, tenantId: T, ownerUserId: U.OWNER }));

  // Workspace A membership. COMPLIANCE_OFFICER and AUDITOR are added as plain members on
  // purpose: membership must NOT be enough for them to execute (§5.3 "cannot execute").
  for (const who of [U.MEMBER, U.WORKFLOW_OWNER, U.APPROVER, U.COMPLIANCE_OFFICER, U.AUDITOR]) {
    writes.push(workspaceMemberTuples(WS_A, who, 'member').current);
  }

  writes.push(
    ...agentCreatedTuples({ agentId: AGENT_A, workspaceId: WS_A, tenantId: T, ownerUserId: U.WORKFLOW_OWNER }),
  );
  await client.write(writes);
}, 60_000);

type Expect = [who: string, relation: string, object: string, allowed: boolean];

const ws = fga.workspace;
const u = fga.user;

const cases: Expect[] = [
  // --- can_run_agent: workspace membership, minus the non-executor roles
  [U.OWNER, 'can_run_agent', ws(WS_A), true],
  [U.ADMIN, 'can_run_agent', ws(WS_A), true],
  [U.WORKFLOW_OWNER, 'can_run_agent', ws(WS_A), true],
  [U.APPROVER, 'can_run_agent', ws(WS_A), true],
  [U.MEMBER, 'can_run_agent', ws(WS_A), true],
  [U.COMPLIANCE_OFFICER, 'can_run_agent', ws(WS_A), false],
  [U.AUDITOR, 'can_run_agent', ws(WS_A), false],
  [OUTSIDER, 'can_run_agent', ws(WS_A), false],

  // --- THE DoD CASE: a member of A cannot run in B
  [U.MEMBER, 'can_run_agent', ws(WS_B), false],
  [U.WORKFLOW_OWNER, 'can_run_agent', ws(WS_B), false],
  // tenant admins reach every workspace in their tenant
  [U.ADMIN, 'can_run_agent', ws(WS_B), true],

  // --- can_manage: admins only
  [U.OWNER, 'can_manage', ws(WS_A), true],
  [U.ADMIN, 'can_manage', ws(WS_A), true],
  [U.WORKFLOW_OWNER, 'can_manage', ws(WS_A), false],
  [U.MEMBER, 'can_manage', ws(WS_A), false],
  [U.COMPLIANCE_OFFICER, 'can_manage', ws(WS_A), false],
  [U.AUDITOR, 'can_manage', ws(WS_A), false],
  [OUTSIDER, 'can_manage', ws(WS_A), false],

  // --- can_view_audit: admins, auditors, compliance
  [U.ADMIN, 'can_view_audit', ws(WS_B), true],
  [U.AUDITOR, 'can_view_audit', ws(WS_B), true],
  [U.COMPLIANCE_OFFICER, 'can_view_audit', ws(WS_B), true],
  [U.MEMBER, 'can_view_audit', ws(WS_A), false],
  [U.APPROVER, 'can_view_audit', ws(WS_A), false],
  [OUTSIDER, 'can_view_audit', ws(WS_A), false],

  // --- agents
  [U.WORKFLOW_OWNER, 'can_run', fga.agent(AGENT_A), true],
  [U.MEMBER, 'can_run', fga.agent(AGENT_A), true],
  [U.COMPLIANCE_OFFICER, 'can_run', fga.agent(AGENT_A), false],
  [U.AUDITOR, 'can_run', fga.agent(AGENT_A), false],
  [OUTSIDER, 'can_run', fga.agent(AGENT_A), false],
  [U.WORKFLOW_OWNER, 'can_manage', fga.agent(AGENT_A), true],
  [U.MEMBER, 'can_manage', fga.agent(AGENT_A), false],
  [U.ADMIN, 'can_manage', fga.agent(AGENT_A), true],

  // --- tenant relations are exactly what the role maps to
  [U.OWNER, 'admin', fga.tenant(T), true],
  [U.ADMIN, 'owner', fga.tenant(T), false],
  [U.AUDITOR, 'non_executor', fga.tenant(T), true],
  [U.COMPLIANCE_OFFICER, 'non_executor', fga.tenant(T), true],
  [U.MEMBER, 'non_executor', fga.tenant(T), false],
  [OUTSIDER, 'member', fga.tenant(T), false],
];

describe('authorization model — role × relation', () => {
  it.each(cases)('%s %s %s → %s', async (who, relation, object, allowed) => {
    expect(await client.check(tuple(u(who), relation, object))).toBe(allowed);
  });

  it('batchCheck agrees with individual checks', async () => {
    const results = await client.batchCheck(cases.map(([who, r, o]) => tuple(u(who), r, o)));
    expect(results).toEqual(cases.map((c) => c[3]));
  });
});

describe('tuple lifecycle', () => {
  it('removing membership revokes can_run_agent immediately', async () => {
    const tmp = 'u-temp';
    await client.write([tenantRoleTuples(T, tmp, 'MEMBER').current, workspaceMemberTuples(WS_B, tmp, 'member').current]);
    expect(await client.check(tuple(u(tmp), 'can_run_agent', ws(WS_B)))).toBe(true);
    await client.write([], workspaceMemberTuples(WS_B, tmp, 'member').all);
    expect(await client.check(tuple(u(tmp), 'can_run_agent', ws(WS_B)))).toBe(false);
  });

  it('a role change replaces the tenant relation rather than accumulating it', async () => {
    const tmp = 'u-promoted';
    await client.write([tenantRoleTuples(T, tmp, 'ADMIN').current]);
    expect(await client.check(tuple(u(tmp), 'can_manage', ws(WS_A)))).toBe(true);

    const demoted = tenantRoleTuples(T, tmp, 'AUDITOR');
    await client.write([demoted.current], demoted.stale);
    expect(await client.check(tuple(u(tmp), 'can_manage', ws(WS_A)))).toBe(false);
    expect(await client.check(tuple(u(tmp), 'can_view_audit', ws(WS_A)))).toBe(true);
  });

  it('writes are idempotent — a retry after partial failure converges', async () => {
    const t = workspaceMemberTuples(WS_A, 'u-retry', 'member').current;
    await client.write([t]);
    await expect(client.write([t])).resolves.toBeUndefined();
    await client.write([], [t]);
    await expect(client.write([], [t])).resolves.toBeUndefined();
  });

  it('listObjects returns only the workspaces a user can run in', async () => {
    const objects = await client.listObjects(u(U.MEMBER), 'can_run_agent', 'workspace');
    expect(objects).toEqual([ws(WS_A)]);
  });

  it('the document type exists now, for Module 9 (public viewer and parent membership)', async () => {
    await client.write([
      tuple(ws(WS_A), 'parent', fga.document('doc-1')),
      tuple(fga.anyUser, 'viewer', fga.document('doc-public')),
    ]);
    expect(await client.check(tuple(u(U.MEMBER), 'can_read', fga.document('doc-1')))).toBe(true);
    expect(await client.check(tuple(u(OUTSIDER), 'can_read', fga.document('doc-1')))).toBe(false);
    expect(await client.check(tuple(u(OUTSIDER), 'can_read', fga.document('doc-public')))).toBe(true);
  });
});
