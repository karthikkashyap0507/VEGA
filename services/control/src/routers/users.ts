import { and, count, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { problems } from '@vega/shared';
import { schema } from '@vega/db';
import { InviteUser, PageQuery, UpdateUser, Uuid } from '@vega/contracts';
import { tenantRoleTuples, workspaceMemberTuples, type Role, type TupleKey } from '@vega/authz';
import {
  ProblemError,
  procedure,
  requireCapability,
  router,
  type AuthedContext,
} from '../trpc.js';
import { afterCursor, decodeCursor, emitEvent, isUniqueViolation, newestFirst, page, toUser } from '../lib.js';

/**
 * Users — module1.md §6.2 "invite, role assignment, deactivate".
 *
 * Guards that exist because the obvious implementation gets them wrong:
 *   · only an OWNER can create or modify an OWNER (no escalation through ADMIN)
 *   · nobody changes their own role or status (no self-escalation, no self-lockout)
 *   · the last active OWNER cannot be demoted or deactivated (tenant stays governable)
 *   · deactivation revokes every session immediately, not at expiry
 */

function splitName(displayName: string | undefined, email: string) {
  const base = (displayName ?? email.split('@')[0] ?? 'User').trim();
  const [given, ...rest] = base.split(/\s+/);
  return { givenName: given || 'User', familyName: rest.join(' ') || '-' };
}

async function activeOwnerCount(ctx: AuthedContext): Promise<number> {
  const [row] = await ctx.db((db) =>
    db
      .select({ n: count() })
      .from(schema.users)
      .where(and(eq(schema.users.role, 'OWNER'), eq(schema.users.status, 'active'))),
  );
  return row?.n ?? 0;
}

async function loadUser(ctx: AuthedContext, userId: string) {
  const [row] = await ctx.db((db) => db.select().from(schema.users).where(eq(schema.users.id, userId)));
  if (!row) throw new ProblemError(problems.notFound('user not found'));
  return row;
}

/** Every tuple that grants this user anything, from the database's point of view. */
async function userTuples(ctx: AuthedContext, userId: string, role: Role): Promise<TupleKey[]> {
  const memberships = await ctx.db((db) =>
    db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, userId)),
  );
  return [
    tenantRoleTuples(ctx.principal.tenantId, userId, role).current,
    ...memberships.map((m) => workspaceMemberTuples(m.workspaceId, userId, m.role as 'owner' | 'admin' | 'member').current),
  ];
}

function allTenantRelations(tenantId: string, userId: string) {
  const { current, stale } = tenantRoleTuples(tenantId, userId, 'MEMBER');
  return [current, ...stale];
}

export const usersRouter = router({
  list: procedure.input(PageQuery.extend({ status: z.enum(['active', 'invited', 'deactivated']).optional() })).query(
    async ({ ctx, input }) => {
      requireCapability(ctx, 'users.read');
      const cursor = decodeCursor(input.cursor);
      const rows = await ctx.db((db) =>
        db
          .select()
          .from(schema.users)
          .where(
            and(
              input.status ? eq(schema.users.status, input.status) : undefined,
              afterCursor(schema.users.createdAt, schema.users.id, cursor),
            ),
          )
          .orderBy(...newestFirst(schema.users.createdAt, schema.users.id))
          .limit(input.limit + 1),
      );
      return page(rows, input.limit, toUser);
    },
  ),

  get: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'users.read');
    return toUser(await loadUser(ctx, input.id));
  }),

  /**
   * Creates the Zitadel user in the TENANT's organization, then the users row, then the
   * tenant-role tuple. All-or-nothing by compensation: a later failure undoes the earlier
   * steps, so a half-invited user never exists.
   *
   * Re-inviting an email that is still `invited` is a resend, not a conflict — which also
   * makes a client retry after a network failure converge.
   */
  invite: procedure.input(InviteUser).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'users.manage');
    if (input.role === 'OWNER' && ctx.principal.role !== 'OWNER') {
      throw new ProblemError(problems.forbidden('only an OWNER can invite an OWNER'));
    }

    const email = input.email.toLowerCase();
    const [existing] = await ctx.db((db) =>
      db.select().from(schema.users).where(eq(schema.users.email, email)),
    );

    if (existing) {
      if (existing.status !== 'invited') {
        throw new ProblemError(problems.conflict('a user with this email already exists in this tenant'));
      }
      await ctx.deps.fga.write([tenantRoleTuples(ctx.principal.tenantId, existing.id, existing.role as Role).current]);
      const code = existing.idpSubject
        ? await ctx.deps.identity.createInviteCode(existing.idpSubject, {
            returnCode: ctx.deps.returnInviteCodes ?? false,
          })
        : {};
      return { user: toUser(existing), ...(code.code ? { inviteCode: code.code } : {}) };
    }

    const [seats] = await ctx.db((db) =>
      db.select({ n: count() }).from(schema.users).where(ne(schema.users.status, 'deactivated')),
    );
    if ((seats?.n ?? 0) >= ctx.entitlements.limits.seats) {
      throw new ProblemError(
        problems.limitExceeded('seats', `this plan includes ${ctx.entitlements.limits.seats} seat(s)`),
      );
    }

    const [tenant] = await ctx.db((db) =>
      db.select({ idpOrgId: schema.tenants.idpOrgId }).from(schema.tenants).where(eq(schema.tenants.id, ctx.principal.tenantId)),
    );
    if (!tenant?.idpOrgId) {
      throw new ProblemError(problems.preconditionFailed('tenant has no identity organization'));
    }

    const { userId: idpUserId } = await ctx.deps.identity.createHumanUser({
      orgId: tenant.idpOrgId,
      email,
      ...splitName(input.displayName, email),
      ...(input.displayName ? { displayName: input.displayName } : {}),
    });

    let row: typeof schema.users.$inferSelect;
    try {
      row = await ctx.db(async (db) => {
        const [created] = await db
          .insert(schema.users)
          .values({
            tenantId: ctx.principal.tenantId,
            email,
            displayName: input.displayName ?? null,
            role: input.role,
            idpSubject: idpUserId,
            status: 'invited',
          })
          .returning();
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'user.invited', {
          userId: created!.id,
          role: input.role,
        });
        return created!;
      });
    } catch (error) {
      await ctx.deps.identity.deleteUser(idpUserId).catch((e: unknown) =>
        ctx.log.error({ err: e, idpUserId }, 'compensation failed: orphaned IdP user'),
      );
      if (isUniqueViolation(error)) throw new ProblemError(problems.conflict('user already exists'));
      throw error;
    }

    try {
      await ctx.deps.fga.write([tenantRoleTuples(ctx.principal.tenantId, row.id, input.role).current]);
    } catch (error) {
      ctx.log.error({ err: error }, 'tuple write failed during invite; compensating');
      await ctx.db((db) => db.delete(schema.users).where(eq(schema.users.id, row.id)));
      await ctx.deps.identity.deleteUser(idpUserId).catch(() => undefined);
      throw new ProblemError(problems.upstreamUnavailable('authorization'));
    }

    const code = await ctx.deps.identity
      .createInviteCode(idpUserId, { returnCode: ctx.deps.returnInviteCodes ?? false })
      .catch((e: unknown) => {
        // The user exists and can be re-invited; failing the whole request here would
        // strand an admin with a "conflict" on retry.
        ctx.log.warn({ err: e }, 'invite code could not be issued; re-invite to resend');
        return {} as { code?: string };
      });

    return { user: toUser(row), ...(code.code ? { inviteCode: code.code } : {}) };
  }),

  update: procedure.input(UpdateUser.extend({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'users.manage');
    if (input.id === ctx.principal.userId) {
      throw new ProblemError(problems.forbidden('you cannot change your own role or status'));
    }
    const target = await loadUser(ctx, input.id);
    const touchesOwner = target.role === 'OWNER' || input.role === 'OWNER';
    if (touchesOwner && ctx.principal.role !== 'OWNER') {
      throw new ProblemError(problems.forbidden('only an OWNER can change an OWNER'));
    }

    const nextRole = (input.role ?? target.role) as Role;
    const nextStatus = input.status ?? target.status;

    const losesOwner =
      target.role === 'OWNER' &&
      target.status === 'active' &&
      (nextRole !== 'OWNER' || nextStatus !== 'active');
    if (losesOwner && (await activeOwnerCount(ctx)) <= 1) {
      throw new ProblemError(problems.preconditionFailed('the tenant must keep at least one active OWNER'));
    }

    const deactivating = nextStatus === 'deactivated' && target.status !== 'deactivated';
    const reactivating = nextStatus === 'active' && target.status === 'deactivated';

    // REVOCATION FIRST (fail closed): strip every tenant relation, and on deactivation every
    // workspace relation, before the database says anything changed.
    const revoke: TupleKey[] = allTenantRelations(ctx.principal.tenantId, target.id);
    if (deactivating) {
      const memberships = await ctx.db((db) =>
        db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, target.id)),
      );
      for (const m of memberships) revoke.push(...workspaceMemberTuples(m.workspaceId, target.id, 'member').all);
    }
    await ctx.deps.fga.write([], revoke);

    if (deactivating && target.idpSubject) await ctx.deps.identity.deactivateUser(target.idpSubject);
    if (reactivating && target.idpSubject) await ctx.deps.identity.reactivateUser(target.idpSubject);

    const updated = await ctx.db(async (db) => {
      const [row] = await db
        .update(schema.users)
        .set({ role: nextRole, status: nextStatus })
        .where(eq(schema.users.id, target.id))
        .returning();
      if (deactivating) {
        await db
          .update(schema.sessions)
          .set({ revokedAt: sql`now()`, revokeReason: 'user_deactivated' })
          .where(and(eq(schema.sessions.userId, target.id), sql`${schema.sessions.revokedAt} IS NULL`));
      }
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'user.updated', {
        userId: target.id,
        role: { from: target.role, to: nextRole },
        status: { from: target.status, to: nextStatus },
      });
      return row!;
    });

    // Re-grant for a user who is (still) able to act. Always re-asserted, so a retry after a
    // partial failure converges on the database's view.
    if (nextStatus !== 'deactivated') {
      await ctx.deps.fga.write(await userTuples(ctx, target.id, nextRole));
    }
    return toUser(updated);
  }),

  /**
   * DELETE /v1/users/:id. Users are never hard-deleted: their id is on agents they owned and,
   * from Module 7, on signed audit entries. Removal deactivates, drops every membership, and
   * revokes sessions. A user who still owns agents must hand them over first.
   */
  remove: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'users.manage');
    if (input.id === ctx.principal.userId) {
      throw new ProblemError(problems.forbidden('you cannot remove yourself'));
    }
    const target = await loadUser(ctx, input.id);
    if (target.role === 'OWNER' && ctx.principal.role !== 'OWNER') {
      throw new ProblemError(problems.forbidden('only an OWNER can remove an OWNER'));
    }
    if (target.role === 'OWNER' && target.status === 'active' && (await activeOwnerCount(ctx)) <= 1) {
      throw new ProblemError(problems.preconditionFailed('the tenant must keep at least one active OWNER'));
    }
    const [owned] = await ctx.db((db) =>
      db
        .select({ n: count() })
        .from(schema.agents)
        .where(and(eq(schema.agents.ownerUserId, target.id), ne(schema.agents.status, 'archived'))),
    );
    if ((owned?.n ?? 0) > 0) {
      throw new ProblemError(problems.preconditionFailed('transfer ownership of this user\'s agents first'));
    }

    const memberships = await ctx.db((db) =>
      db.select().from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, target.id)),
    );
    await ctx.deps.fga.write(
      [],
      [
        ...allTenantRelations(ctx.principal.tenantId, target.id),
        ...memberships.flatMap((m) => workspaceMemberTuples(m.workspaceId, target.id, 'member').all),
      ],
    );
    if (target.idpSubject) {
      await ctx.deps.identity.deactivateUser(target.idpSubject).catch((e: unknown) => {
        ctx.log.warn({ err: e }, 'IdP deactivation failed; access is already revoked here');
      });
    }

    await ctx.db(async (db) => {
      await db.delete(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, target.id));
      await db.update(schema.users).set({ status: 'deactivated' }).where(eq(schema.users.id, target.id));
      await db
        .update(schema.sessions)
        .set({ revokedAt: sql`now()`, revokeReason: 'user_removed' })
        .where(and(eq(schema.sessions.userId, target.id), sql`${schema.sessions.revokedAt} IS NULL`));
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'user.removed', { userId: target.id });
    });
    return { ok: true as const };
  }),
});

