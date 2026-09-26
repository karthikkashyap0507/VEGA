import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { problems } from '@vega/shared';
import { schema } from '@vega/db';
import { RETENTION_DAYS_FLOOR, UpdateTenant } from '@vega/contracts';
import { ProblemError, procedure, requireCapability, router } from '../trpc.js';
import { emitEvent, toTenant } from '../lib.js';

/**
 * Tenant settings — module1.md §6.2. Retention has a 180-day floor (EU AI Act Art. 12),
 * enforced three times: the Zod contract, this procedure, and a CHECK constraint. The UI
 * enforces it too, but the UI is not enforcement.
 */
const TenantSettings = z
  .object({
    /** Whether the admin console shows SSO configuration. Exposure only (D-09). */
    ssoEnforced: z.boolean().optional(),
    defaultWorkspaceId: z.string().uuid().optional(),
  })
  .strict();

export const tenantsRouter = router({
  current: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'tenant.read');
    const [row] = await ctx.db((db) =>
      db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.principal.tenantId)),
    );
    if (!row) throw new ProblemError(problems.notFound());
    return toTenant(row);
  }),

  update: procedure
    .input(UpdateTenant.extend({ settings: TenantSettings.optional() }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'tenant.update');
      if (input.retentionDays !== undefined && input.retentionDays < RETENTION_DAYS_FLOOR) {
        throw new ProblemError(
          problems.validation([
            { path: 'retentionDays', message: `must be at least ${RETENTION_DAYS_FLOOR} days (EU AI Act Art. 12)` },
          ]),
        );
      }
      const row = await ctx.db(async (db) => {
        const [current] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.principal.tenantId));
        if (!current) throw new ProblemError(problems.notFound());
        const [updated] = await db
          .update(schema.tenants)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}),
            ...(input.settings !== undefined
              ? { settings: { ...(current.settings as object), ...input.settings } }
              : {}),
          })
          .where(eq(schema.tenants.id, ctx.principal.tenantId))
          .returning();
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'tenant.updated', {
          fields: Object.keys(input),
        });
        return updated!;
      });
      return toTenant(row);
    }),
});
