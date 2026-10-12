import { canApproveAs, type Role } from '@vega/authz';

/**
 * ROUTING — docs/module8.md §5.4, §14.1.
 *
 *   · role → a person who may approve it, honoring active delegations (out of office)
 *   · separation of duties: the person the run acts for never approves its action
 *   · unresponsive → the escalation chain (role → ADMIN → OWNER) after part of the window
 *   · self-serve plans: no routing at all — the account owner is the only approver; the packet,
 *     the telemetry and the receipt are identical
 *
 * Authorization is decided AGAIN when someone decides (`mayApprove`): a role changed or a
 * delegation ended since assignment is a refusal, not an inherited permission.
 */

export interface Person {
  id: string;
  role: Role;
  status: string;
  email: string;
}

export interface DelegationRow {
  id: string;
  fromUser: string;
  toUser: string;
  roleScope: string | null;
  startsAt: Date;
  endsAt: Date;
  revokedAt: Date | null;
}

export const activeAt = (d: DelegationRow, now: Date) => !d.revokedAt && d.startsAt <= now && now < d.endsAt;
const covers = (d: DelegationRow, role: string) => d.roleScope === null || d.roleScope === role;

export interface Routed {
  assignedTo: string | null;
  delegatedFrom: string | null;
  eligible: string[];
}

export function resolveApprover(i: {
  people: Person[];
  delegations: DelegationRow[];
  role: string;
  requester: string;
  separationOfDuties: boolean;
  /** Self-serve plans: the owner decides everything. */
  singleUserOwner?: string | null;
  exclude?: readonly string[];
  now: Date;
}): Routed {
  if (i.singleUserOwner) return { assignedTo: i.singleUserOwner, delegatedFrom: null, eligible: [i.singleUserOwner] };
  const excluded = new Set(i.exclude ?? []);
  const eligible = i.people
    .filter((p) => p.status === 'active' && canApproveAs(p.role, i.role) && !excluded.has(p.id) && !(i.separationOfDuties && p.id === i.requester))
    // Deterministic: the role named first, then the least senior role that may decide, then by address.
    .sort((a, b) => Number(b.role === i.role) - Number(a.role === i.role) || seniority(a.role) - seniority(b.role) || a.email.localeCompare(b.email));
  const primary = eligible[0];
  if (!primary) return { assignedTo: null, delegatedFrom: null, eligible: [] };
  const byId = new Map(i.people.map((p) => [p.id, p]));
  const away = i.delegations.find((d) => d.fromUser === primary.id && activeAt(d, i.now) && covers(d, i.role) && byId.get(d.toUser)?.status === 'active' && !(i.separationOfDuties && d.toUser === i.requester));
  return away ? { assignedTo: away.toUser, delegatedFrom: primary.id, eligible: [...eligible.map((p) => p.id), away.toUser] } : { assignedTo: primary.id, delegatedFrom: null, eligible: eligible.map((p) => p.id) };
}

const SENIORITY: Record<string, number> = { APPROVER: 1, COMPLIANCE_OFFICER: 2, WORKFLOW_OWNER: 2, ADMIN: 3, OWNER: 4 };
const seniority = (r: string) => SENIORITY[r] ?? 0;

/** The next role up when nobody answered in time. */
export function nextRole(role: string): string | null {
  if (role === 'OWNER') return null;
  if (role === 'ADMIN') return 'OWNER';
  return 'ADMIN';
}

/**
 * May `user` decide an approval routed to `role`, right now? Their own role, or an active
 * delegation from someone whose role may (and never a role the delegator does not hold).
 */
export function mayApprove(user: Person, role: string, delegationsTo: DelegationRow[], people: Map<string, Person>, now: Date): { ok: true; onBehalfOf: string | null } | { ok: false; reason: string } {
  if (user.status !== 'active') return { ok: false, reason: 'your account is not active' };
  if (canApproveAs(user.role, role)) return { ok: true, onBehalfOf: null };
  for (const d of delegationsTo) {
    if (d.toUser !== user.id || !activeAt(d, now) || !covers(d, role)) continue;
    const from = people.get(d.fromUser);
    if (from?.status === 'active' && canApproveAs(from.role, role)) return { ok: true, onBehalfOf: from.id };
  }
  return { ok: false, reason: `this action needs approval by ${role}; your role is ${user.role} and no active delegation covers it` };
}

/** Delegation rules (§10 "delegation abuse"): time-bounded, and never more than you hold. */
export function checkDelegation(i: { from: Person; to: Person; roleScope: string | null; startsAt: Date; endsAt: Date }): string[] {
  const problems: string[] = [];
  if (i.from.id === i.to.id) problems.push('you cannot delegate to yourself');
  if (!(i.endsAt > i.startsAt)) problems.push('a delegation must end after it starts');
  if (i.endsAt.getTime() - i.startsAt.getTime() > 90 * 86_400_000) problems.push('a delegation lasts at most 90 days');
  if (i.roleScope ? !canApproveAs(i.from.role, i.roleScope) : !canApproveAs(i.from.role, 'APPROVER')) problems.push(`you cannot delegate approval authority you do not hold${i.roleScope ? ` (${i.roleScope})` : ''}`);
  if (i.to.status !== 'active') problems.push('the person you delegate to is not active');
  return problems;
}
