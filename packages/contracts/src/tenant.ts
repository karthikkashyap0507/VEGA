import { z } from 'zod';
import { Plan, TenantStatus } from './enums.js';
import { Slug, Timestamp, Uuid } from './common.js';

/**
 * EU AI Act Art. 12 requires >= 6 months of tamper-evident audit retention. The floor is
 * enforced in the API and the UI, not just documented (module1.md §6.2).
 */
export const RETENTION_DAYS_FLOOR = 180;

export const Tenant = z.object({
  id: Uuid,
  name: z.string().min(1).max(200),
  slug: Slug,
  plan: Plan,
  region: z.string().min(2).max(32),
  retentionDays: z.number().int().min(RETENTION_DAYS_FLOOR).max(3650),
  status: TenantStatus,
  createdAt: Timestamp,
});
export type Tenant = z.infer<typeof Tenant>;

export const UpdateTenant = Tenant.pick({
  name: true,
  retentionDays: true,
}).partial();
export type UpdateTenant = z.infer<typeof UpdateTenant>;
