import { eq } from 'drizzle-orm';
import { schema } from '@vega/db';
import { ROLE_CAPABILITIES } from '@vega/authz';
import type { Me, Plan } from '@vega/contracts';
import { procedure, router } from '../trpc.js';
import { toTenant, toUser } from '../lib.js';

/** GET /v1/me — identity, role, tenant, and what the UI may expose (implementation plan Step 3 DoD). */
export const meRouter = router({
  get: procedure.query(async ({ ctx }): Promise<Me> => {
    const { user, tenant, memberships } = await ctx.db(async (db) => {
      const [user] = await db.select().from(schema.users).where(eq(schema.users.id, ctx.principal.userId));
      const [tenant] = await db.select().from(schema.tenants).where(eq(schema.tenants.id, ctx.principal.tenantId));
      const memberships = await db
        .select({ workspaceId: schema.workspaceMembers.workspaceId })
        .from(schema.workspaceMembers)
        .where(eq(schema.workspaceMembers.userId, ctx.principal.userId));
      return { user: user!, tenant: tenant!, memberships };
    });
    const { settings: _settings, ...tenantOut } = toTenant(tenant);
    return {
      user: toUser(user),
      tenant: tenantOut,
      tenantId: tenant.id,
      workspaceIds: memberships.map((m) => m.workspaceId),
      capabilities: [...ROLE_CAPABILITIES[ctx.principal.role]].sort(),
      entitlements: { plan: ctx.plan as Plan, ...ctx.entitlements },
    };
  }),
});
