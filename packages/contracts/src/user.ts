import { z } from 'zod';
import { Role, UserStatus } from './enums.js';
import { Email, Timestamp, Uuid } from './common.js';

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
  status: UserStatus.optional(),
});
export type UpdateUser = z.infer<typeof UpdateUser>;

/** Response for GET /v1/me — identity plus the tenant it resolved to. */
export const Me = z.object({
  user: User,
  tenantId: Uuid,
  workspaceIds: z.array(Uuid),
});
export type Me = z.infer<typeof Me>;
