import type { TupleKey } from './client.js';
import { fga, tuple } from './objects.js';

/**
 * Role model — docs/module1.md §5.3.
 *
 * Two layers, deliberately:
 *   1. CAPABILITIES — what a tenant-level role may do at all (this file). Pure, synchronous,
 *      exhaustively testable, and the first gate on every control-plane procedure.
 *   2. RELATIONSHIPS — which specific workspace/agent/document a user may act on (OpenFGA,
 *      model/model.fga). Checked for every resource-scoped operation.
 *
 * A request must pass both. Neither alone is sufficient: a MEMBER has `agents.run` but only
 * on workspaces they belong to; a workspace admin tuple does not give an AUDITOR the ability
 * to execute.
 */

export const ROLES = [
  'OWNER',
  'ADMIN',
  'COMPLIANCE_OFFICER',
  'WORKFLOW_OWNER',
  'APPROVER',
  'MEMBER',
  'AUDITOR',
] as const;
export type Role = (typeof ROLES)[number];

export const CAPABILITIES = [
  'tenant.read',
  'tenant.update',
  'tenant.delete',
  'billing.manage',
  'users.read',
  'users.manage',
  'workspaces.read',
  'workspaces.create',
  'workspaces.manage',
  'agents.read',
  'agents.create',
  'agents.manage',
  'agents.run',
  'connectors.read',
  'connectors.manage',
  'policy.read',
  'policy.manage',
  'budgets.manage',
  'approvals.decide',
  'autonomy.request_promotion',
  'autonomy.ratify',
  'audit.read',
  'audit.read_bodies',
  'evidence.export',
  'sessions.manage',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ALL = new Set<Capability>(CAPABILITIES);

const minus = (base: Set<Capability>, ...remove: Capability[]) => {
  const out = new Set(base);
  for (const r of remove) out.delete(r);
  return out;
};

/**
 * The matrix. Read against §5.3:
 *   OWNER               everything, including billing and tenant deletion
 *   ADMIN               users, connectors, policy, budgets — not billing, not deletion
 *   COMPLIANCE_OFFICER  full audit read, evidence packs, policy read — cannot execute
 *   WORKFLOW_OWNER      owns agents; requests autonomy promotion
 *   APPROVER            decides approval requests routed to them
 *   MEMBER              runs agents within granted scopes
 *   AUDITOR             read-only across the audit plane; no message bodies unless granted
 */
export const ROLE_CAPABILITIES: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  OWNER: ALL,
  ADMIN: minus(ALL, 'billing.manage', 'tenant.delete'),
  COMPLIANCE_OFFICER: new Set<Capability>([
    'tenant.read',
    'users.read',
    'workspaces.read',
    'agents.read',
    'connectors.read',
    'policy.read',
    'audit.read',
    'audit.read_bodies',
    'evidence.export',
    'autonomy.ratify',
  ]),
  WORKFLOW_OWNER: new Set<Capability>([
    'tenant.read',
    'workspaces.read',
    'agents.read',
    'connectors.read',
    'agents.create',
    'agents.manage',
    'agents.run',
    'policy.read',
    'autonomy.request_promotion',
  ]),
  APPROVER: new Set<Capability>([
    'tenant.read',
    'workspaces.read',
    'agents.read',
    'approvals.decide',
  ]),
  MEMBER: new Set<Capability>(['tenant.read', 'workspaces.read', 'agents.read', 'agents.run']),
  AUDITOR: new Set<Capability>(['tenant.read', 'users.read', 'workspaces.read', 'agents.read', 'connectors.read', 'audit.read']),
};

/** Capabilities that act on the world. Roles that "cannot execute" must hold none of them. */
export const EXECUTION_CAPABILITIES: readonly Capability[] = ['agents.run', 'approvals.decide'];

export function hasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

/**
 * May a user holding `role` decide an approval that a policy routed to `required` (module5.md
 * §5.1 `approver_role`)? Deciding always needs `approvals.decide` (roles that "cannot execute"
 * never approve). Then:
 *   APPROVER → any role that decides approvals
 *   ADMIN    → ADMIN or OWNER
 *   OWNER    → OWNER
 *   anything else (a policy may name a role the tenant does not have yet, such as
 *   REGISTERED_PRINCIPAL) → ADMIN or OWNER until approval routing (Module 8) maps it.
 */
export function canApproveAs(role: Role, required: string | null | undefined): boolean {
  if (!hasCapability(role, 'approvals.decide')) return false;
  if (!required || required === 'APPROVER') return true;
  if (required === 'OWNER') return role === 'OWNER';
  return role === 'OWNER' || role === 'ADMIN';
}

/** The tenant relation a role maps to in OpenFGA. Exactly one per role. */
export function tenantRelationFor(role: Role): 'owner' | 'admin' | 'compliance' | 'auditor' | 'member' {
  switch (role) {
    case 'OWNER':
      return 'owner';
    case 'ADMIN':
      return 'admin';
    case 'COMPLIANCE_OFFICER':
      return 'compliance';
    case 'AUDITOR':
      return 'auditor';
    case 'WORKFLOW_OWNER':
    case 'APPROVER':
    case 'MEMBER':
      return 'member';
  }
}

const TENANT_RELATIONS = ['owner', 'admin', 'compliance', 'auditor', 'member'] as const;

/**
 * Tuples for a user's tenant role. On a role change the caller deletes `all` and writes
 * `current` — so a demoted admin loses the admin tuple rather than accumulating relations.
 */
export function tenantRoleTuples(tenantId: string, userId: string, role: Role) {
  const user = fga.user(userId);
  const object = fga.tenant(tenantId);
  const current = tuple(user, tenantRelationFor(role), object);
  const all: TupleKey[] = TENANT_RELATIONS.map((r) => tuple(user, r, object));
  return { current, stale: all.filter((t) => t.relation !== current.relation) };
}
