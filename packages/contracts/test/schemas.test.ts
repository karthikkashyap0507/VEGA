import { describe, expect, it } from 'vitest';
import {
  Agent,
  ExposedFeatures,
  Plan,
  RETENTION_DAYS_FLOOR,
  Role,
  Tenant,
  User,
} from '../src/index.js';

const NOW = '2026-08-23T10:00:00.000Z';

describe('Tenant', () => {
  const base = {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Acme Advisors',
    slug: 'acme-advisors',
    plan: 'business' as const,
    region: 'eu-west-1',
    retentionDays: 400,
    status: 'active' as const,
    createdAt: NOW,
  };

  it('accepts a valid tenant', () => {
    expect(Tenant.parse(base)).toMatchObject({ slug: 'acme-advisors' });
  });

  // EU AI Act Art. 12 requires >= 6 months of tamper-evident audit retention. The floor is
  // enforced by the schema, so it cannot be bypassed by an API caller (module1.md §6.2).
  it('rejects retention below the Art. 12 floor', () => {
    expect(() => Tenant.parse({ ...base, retentionDays: RETENTION_DAYS_FLOOR - 1 })).toThrow();
  });

  it('accepts retention exactly at the floor', () => {
    expect(Tenant.parse({ ...base, retentionDays: RETENTION_DAYS_FLOOR })).toBeTruthy();
  });

  it('rejects a malformed slug', () => {
    expect(() => Tenant.parse({ ...base, slug: 'Acme Advisors' })).toThrow();
  });
});

describe('enums', () => {
  it('carries every role from module1.md §5.3', () => {
    expect(Role.options).toEqual([
      'OWNER',
      'ADMIN',
      'COMPLIANCE_OFFICER',
      'WORKFLOW_OWNER',
      'APPROVER',
      'MEMBER',
      'AUDITOR',
    ]);
  });

  it('carries every plan from PROJECT.md §22.2', () => {
    expect(Plan.options).toEqual(['free', 'pro', 'business', 'teams', 'enterprise']);
  });
});

describe('entitlements', () => {
  // Decision D-10: undo and taint defense ship identically on every tier, including free.
  // They are the reason anyone chooses this over a free assistant, so they must never
  // become gateable. This test fails loudly if someone adds them.
  it('never exposes undo or taint defense as an entitlement', () => {
    const keys = Object.keys(ExposedFeatures.shape);
    expect(keys).not.toContain('undo');
    expect(keys).not.toContain('taintDefense');
    expect(keys).not.toContain('reversibility');
    expect(keys).not.toContain('holdWindow');
  });
});

describe('Agent', () => {
  // module1.md §5.5: agents are principals with their own identity. Every downstream
  // action records both the agent and the human it acts for.
  it('requires a machine identity distinct from the owning user', () => {
    const agent = {
      id: '00000000-0000-4000-8000-000000000002',
      tenantId: '00000000-0000-4000-8000-000000000001',
      workspaceId: '00000000-0000-4000-8000-000000000003',
      name: 'client-comm',
      version: 1,
      ownerUserId: '00000000-0000-4000-8000-000000000004',
      idpMachineId: 'machine_4412',
      status: 'draft' as const,
      createdAt: NOW,
    };
    expect(Agent.parse(agent).idpMachineId).toBe('machine_4412');
    expect(() => Agent.parse({ ...agent, idpMachineId: '' })).toThrow();
  });

  it('starts as draft — it cannot run until Module 4 gives it a spec', () => {
    expect(Agent.shape.status.parse('draft')).toBe('draft');
  });
});

describe('User', () => {
  it('rejects an invalid email', () => {
    expect(() =>
      User.parse({
        id: '00000000-0000-4000-8000-000000000005',
        tenantId: '00000000-0000-4000-8000-000000000001',
        email: 'not-an-email',
        displayName: null,
        role: 'MEMBER',
        status: 'active',
        lastSeenAt: null,
        createdAt: NOW,
      }),
    ).toThrow();
  });
});
