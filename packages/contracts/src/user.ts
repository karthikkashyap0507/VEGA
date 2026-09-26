import { z } from 'zod';
import { Plan, Role, UserStatus } from './enums.js';
import { Email, Timestamp, Uuid } from './common.js';
import { ExposedFeatures, PlanLimits } from './entitlements.js';
import { Tenant } from './tenant.js';

export const User = z.object({
  id: Uuid,
  tenantId: Uuid,
  email: Email,
  displayName: z.string().max(200).nullable(),
  role: Role,
  status: UserStatus,
  lastSeenAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type User = z.infer<typeof User>;

export const InviteUser = z.object({
  email: Email,
  role: Role,
  displayName: z.string().max(200).optional(),
});
export type InviteUser = z.infer<typeof InviteUser>;

export const UpdateUser = z.object({
  role: Role.optional(),
  /** `invited` is not settable: a user leaves it by signing in. */
  status: z.enum(['active', 'deactivated']).optional(),
});
export type UpdateUser = z.infer<typeof UpdateUser>;

/** Response for GET /v1/me — identity plus the tenant it resolved to. */
export const Me = z.object({
  user: User,
  tenant: Tenant,
  tenantId: Uuid,
  workspaceIds: z.array(Uuid),
  /** What this role may do (packages/authz roles.ts). The UI hides what the API would refuse. */
  capabilities: z.array(z.string()),
  entitlements: z.object({ plan: Plan, limits: PlanLimits, exposed: ExposedFeatures }),
});
export type Me = z.infer<typeof Me>;
