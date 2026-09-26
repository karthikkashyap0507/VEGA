import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  EXECUTION_CAPABILITIES,
  ROLES,
  ROLE_CAPABILITIES,
  canApproveAs,
  hasCapability,
  tenantRelationFor,
  tenantRoleTuples,
} from '../src/roles.js';

describe('role capability matrix (module1.md §5.3)', () => {
  it('OWNER holds every capability', () => {
    for (const c of CAPABILITIES) expect(hasCapability('OWNER', c)).toBe(true);
  });

  it('only OWNER manages billing or deletes the tenant', () => {
    for (const role of ROLES) {
      expect(hasCapability(role, 'billing.manage')).toBe(role === 'OWNER');
      expect(hasCapability(role, 'tenant.delete')).toBe(role === 'OWNER');
    }
  });

  it('ADMIN manages users, connectors, policy, budgets', () => {
    for (const c of ['users.manage', 'connectors.manage', 'policy.manage', 'budgets.manage'] as const) {
      expect(hasCapability('ADMIN', c)).toBe(true);
    }
  });

  it('COMPLIANCE_OFFICER and AUDITOR cannot execute anything', () => {
    for (const role of ['COMPLIANCE_OFFICER', 'AUDITOR'] as const) {
      for (const c of EXECUTION_CAPABILITIES) {
        expect(hasCapability(role, c), `${role} must not hold ${c}`).toBe(false);
      }
    }
  });

  it('AUDITOR reads audit but not message bodies; COMPLIANCE_OFFICER reads both', () => {
    expect(hasCapability('AUDITOR', 'audit.read')).toBe(true);
    expect(hasCapability('AUDITOR', 'audit.read_bodies')).toBe(false);
    expect(hasCapability('COMPLIANCE_OFFICER', 'audit.read_bodies')).toBe(true);
    expect(hasCapability('COMPLIANCE_OFFICER', 'evidence.export')).toBe(true);
  });

  it('WORKFLOW_OWNER requests promotion but cannot ratify it (separation of duties)', () => {
    expect(hasCapability('WORKFLOW_OWNER', 'autonomy.request_promotion')).toBe(true);
    expect(hasCapability('WORKFLOW_OWNER', 'autonomy.ratify')).toBe(false);
  });

  it('APPROVER decides approvals; MEMBER does not', () => {
    expect(hasCapability('APPROVER', 'approvals.decide')).toBe(true);
    expect(hasCapability('MEMBER', 'approvals.decide')).toBe(false);
  });

  it('no role outside OWNER/ADMIN manages users', () => {
    for (const role of ROLES) {
      expect(hasCapability(role, 'users.manage')).toBe(role === 'OWNER' || role === 'ADMIN');
    }
  });

  it('every role can read its own tenant', () => {
    for (const role of ROLES) expect(hasCapability(role, 'tenant.read')).toBe(true);
  });

  it('the matrix names only known capabilities', () => {
    const known = new Set<string>(CAPABILITIES);
    for (const role of ROLES) for (const c of ROLE_CAPABILITIES[role]) expect(known.has(c)).toBe(true);
  });
});

describe('role → tenant relation', () => {
  it('maps every role to exactly one relation', () => {
    for (const role of ROLES) {
      const { current, stale } = tenantRoleTuples('t', 'u', role);
      expect(current.relation).toBe(tenantRelationFor(role));
      expect(stale.map((s) => s.relation)).not.toContain(current.relation);
      expect(stale).toHaveLength(4);
    }
  });
});

describe('approver roles (module5.md §5.1 approver_role)', () => {
  const table: Array<[string | null, string[]]> = [
    [null, ['OWNER', 'ADMIN', 'APPROVER']],
    ['APPROVER', ['OWNER', 'ADMIN', 'APPROVER']],
    ['ADMIN', ['OWNER', 'ADMIN']],
    ['OWNER', ['OWNER']],
    ['REGISTERED_PRINCIPAL', ['OWNER', 'ADMIN']],
  ];
  it.each(table)('%s may be decided by exactly %j', (required, allowed) => {
    expect(ROLES.filter((r) => canApproveAs(r, required))).toEqual(allowed);
  });

  it('a role that cannot execute never approves, whatever the policy names', () => {
    for (const required of ['APPROVER', 'COMPLIANCE_OFFICER', 'AUDITOR', 'ADMIN']) {
      expect(canApproveAs('COMPLIANCE_OFFICER', required)).toBe(false);
      expect(canApproveAs('AUDITOR', required)).toBe(false);
      expect(canApproveAs('MEMBER', required)).toBe(false);
    }
  });
});
