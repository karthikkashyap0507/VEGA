import type { TupleKey } from './client.js';
import { fga, tuple } from './objects.js';

/**
 * Tuple lifecycle for the objects Module 1 creates (implementation plan Step 4).
 *
 * ORDERING RULE (fail closed in both directions):
 *   · GRANTS    — commit the database row first, then write tuples. If the tuple write fails,
 *                 the object exists but nobody can reach it through OpenFGA: denied, not leaked.
 *   · REVOCATIONS — delete tuples first, then the database row. If the database write fails,
 *                 the grant is already gone: denied, not retained.
 * `reconcile*` functions rebuild tuples from the database for the cases in between.
 */

export function workspaceCreatedTuples(input: {
  workspaceId: string;
  tenantId: string;
  ownerUserId: string;
}): TupleKey[] {
  const ws = fga.workspace(input.workspaceId);
  return [
    tuple(fga.tenant(input.tenantId), 'tenant', ws),
    tuple(fga.user(input.ownerUserId), 'owner', ws),
  ];
}

export type WorkspaceMemberRole = 'owner' | 'admin' | 'member';

export function workspaceMemberTuples(workspaceId: string, userId: string, role: WorkspaceMemberRole) {
  const ws = fga.workspace(workspaceId);
  const user = fga.user(userId);
  const current = tuple(user, role, ws);
  const all = (['owner', 'admin', 'member'] as const).map((r) => tuple(user, r, ws));
  return { current, all, stale: all.filter((t) => t.relation !== role) };
}

export function agentCreatedTuples(input: {
  agentId: string;
  workspaceId: string;
  tenantId: string;
  ownerUserId: string;
}): TupleKey[] {
  const agent = fga.agent(input.agentId);
  return [
    tuple(fga.workspace(input.workspaceId), 'workspace', agent),
    tuple(fga.tenant(input.tenantId), 'tenant_of', agent),
    tuple(fga.user(input.ownerUserId), 'owner', agent),
  ];
}

export function agentOwnerChangeTuples(agentId: string, fromUserId: string, toUserId: string) {
  const agent = fga.agent(agentId);
  return {
    writes: [tuple(fga.user(toUserId), 'owner', agent)],
    deletes: [tuple(fga.user(fromUserId), 'owner', agent)],
  };
}
