import { z } from 'zod';

/**
 * Cross-cutting vocabulary. Defined once here so the four planes cannot drift.
 *
 * SCOPE NOTE: only Module 1 vocabulary lives here. Taint levels (M3), reversibility
 * classes (M2/M6), and risk tiers (M5) are deliberately NOT defined yet — they belong to
 * the module that owns their semantics, and inventing them early invites a definition
 * that does not survive contact with the spec.
 */

/** module1.md §5.3. AUDITOR is read-only across the audit plane. */
export const Role = z.enum([
  'OWNER',
  'ADMIN',
  'COMPLIANCE_OFFICER',
  'WORKFLOW_OWNER',
  'APPROVER',
  'MEMBER',
  'AUDITOR',
]);
export type Role = z.infer<typeof Role>;

/** PROJECT.md §22.2. Adding a tier is a `plan_entitlements` row, not a code change (D-09). */
export const Plan = z.enum(['free', 'pro', 'business', 'teams', 'enterprise']);
export type Plan = z.infer<typeof Plan>;

export const TenantStatus = z.enum(['active', 'suspended', 'closed']);
export type TenantStatus = z.infer<typeof TenantStatus>;

export const UserStatus = z.enum(['active', 'invited', 'deactivated']);
export type UserStatus = z.infer<typeof UserStatus>;

/** An agent cannot run until Module 4 gives it a spec, hence `draft` as the initial state. */
export const AgentStatus = z.enum(['draft', 'active', 'suspended', 'archived']);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const WorkspaceRole = z.enum(['owner', 'admin', 'member']);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;
