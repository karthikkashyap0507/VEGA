import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { problems } from '@vega/shared';
import { schema } from '@vega/db';
import { AddWorkspaceMember, CreateWorkspace, PageQuery, UpdateWorkspace, Uuid } from '@vega/contracts';
import { fga, hasCapability, workspaceCreatedTuples, workspaceMemberTuples } from '@vega/authz';
import {
  ProblemError,
  procedure,
  requireCapability,
  requireExposed,
  requireRelation,
  router,
  type AuthedContext,
} from '../trpc.js';
import {
  afterCursor,
  decodeCursor,
  emitEvent,
  isUniqueViolation,
  newestFirst,
  page,
  slugify,
  toWorkspace,
} from '../lib.js';

async function loadWorkspace(ctx: AuthedContext, id: string) {
  const [row] = await ctx.db((db) => db.select().from(schema.workspaces).where(eq(schema.workspaces.id, id)));
  if (!row) throw new ProblemError(problems.notFound('workspace not found'));
  return row;
}

export const workspacesRouter = router({
  /** Tenant admins see every workspace; everyone else sees the ones they belong to. */
  list: procedure
    .input(PageQuery.extend({ includeArchived: z.boolean().default(false) }))
    .query(async ({ ctx, input }) => {
      requireCapability(ctx, 'workspaces.read');
      const cursor = decodeCursor(input.cursor);
      const seesAll = hasCapability(ctx.principal.role, 'workspaces.manage');
      const rows = await ctx.db(async (db) => {
        const memberOf = seesAll
          ? undefined
          : (
              await db
                .select({ id: schema.workspaceMembers.workspaceId })
                .from(schema.workspaceMembers)
                .where(eq(schema.workspaceMembers.userId, ctx.principal.userId))
            ).map((r) => r.id);
        if (memberOf && memberOf.length === 0) return [];
        return db
          .select()
          .from(schema.workspaces)
          .where(
            and(
              memberOf ? inArray(schema.workspaces.id, memberOf) : undefined,
              input.includeArchived ? undefined : isNull(schema.workspaces.archivedAt),
              afterCursor(schema.workspaces.createdAt, schema.workspaces.id, cursor),
            ),
          )
          .orderBy(...newestFirst(schema.workspaces.createdAt, schema.workspaces.id))
          .limit(input.limit + 1);
      });
      return page(rows, input.limit, toWorkspace);
    }),

  get: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'workspaces.read');
    await requireRelation(ctx, 'member', fga.workspace(input.id));
    return toWorkspace(await loadWorkspace(ctx, input.id));
  }),

  create: procedure.input(CreateWorkspace).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'workspaces.create');
    const slug = input.slug ?? slugify(input.name);

    let row: typeof schema.workspaces.$inferSelect;
    try {
      row = await ctx.db(async (db) => {
        const [created] = await db
          .insert(schema.workspaces)
          .values({ tenantId: ctx.principal.tenantId, name: input.name, slug })
          .returning();
        await db.insert(schema.workspaceMembers).values({
          tenantId: ctx.principal.tenantId,
          workspaceId: created!.id,
          userId: ctx.principal.userId,
          role: 'owner',
        });
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'workspace.created', {
          workspaceId: created!.id,
        });
        return created!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProblemError(problems.conflict(`a workspace with slug "${slug}" already exists`));
      }
      throw error;
    }

    // GRANT: database first, then tuples. On failure, compensate so no unreachable
    // workspace is left behind.
    try {
      await ctx.deps.fga.write(
        workspaceCreatedTuples({
          workspaceId: row.id,
          tenantId: ctx.principal.tenantId,
          ownerUserId: ctx.principal.userId,
        }),
      );
    } catch (error) {
      ctx.log.error({ err: error }, 'tuple write failed creating workspace; compensating');
      await ctx.db((db) => db.delete(schema.workspaces).where(eq(schema.workspaces.id, row.id)));
      throw new ProblemError(problems.upstreamUnavailable('authorization'));
    }
    return toWorkspace(row);
  }),

  update: procedure.input(UpdateWorkspace.extend({ id: Uuid })).mutation(async ({ ctx, input }) => {
    await requireRelation(ctx, 'can_manage', fga.workspace(input.id));
    await loadWorkspace(ctx, input.id);
    const row = await ctx.db(async (db) => {
      const [updated] = await db
        .update(schema.workspaces)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.archived !== undefined ? { archivedAt: input.archived ? new Date() : null } : {}),
        })
        .where(eq(schema.workspaces.id, input.id))
        .returning();
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'workspace.updated', {
        workspaceId: input.id,
        fields: Object.keys(input).filter((k) => k !== 'id'),
      });
      return updated!;
    });
    return toWorkspace(row);
  }),

  members: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    await requireRelation(ctx, 'member', fga.workspace(input.id));
    const rows = await ctx.db((db) =>
      db
        .select({
          userId: schema.workspaceMembers.userId,
          role: schema.workspaceMembers.role,
          addedAt: schema.workspaceMembers.addedAt,
          email: schema.users.email,
          displayName: schema.users.displayName,
        })
        .from(schema.workspaceMembers)
        .innerJoin(
          schema.users,
          and(eq(schema.users.id, schema.workspaceMembers.userId), eq(schema.users.tenantId, schema.workspaceMembers.tenantId)),
        )
        .where(eq(schema.workspaceMembers.workspaceId, input.id)),
    );
    return rows.map((r) => ({ ...r, workspaceId: input.id, addedAt: r.addedAt.toISOString() }));
  }),

  /**
   * Adding someone other than yourself is what "shared workspaces" means, so that SURFACE is
   * entitlement-gated (D-09). The membership model underneath is identical on every plan.
   */
  addMember: procedure
    .input(AddWorkspaceMember.extend({ id: Uuid }))
    .mutation(async ({ ctx, input }) => {
      await requireRelation(ctx, 'can_manage', fga.workspace(input.id));
      if (input.userId !== ctx.principal.userId) requireExposed(ctx, 'sharedWorkspaces');
      if (input.role === 'owner') await requireRelation(ctx, 'owner', fga.workspace(input.id));

      const [target] = await ctx.db((db) =>
        db.select().from(schema.users).where(eq(schema.users.id, input.userId)),
      );
      if (!target) throw new ProblemError(problems.notFound('user not found in this tenant'));
      if (target.status === 'deactivated') {
        throw new ProblemError(problems.preconditionFailed('cannot add a deactivated user'));
      }
      await loadWorkspace(ctx, input.id);

      await ctx.db(async (db) => {
        await db
          .insert(schema.workspaceMembers)
          .values({
            tenantId: ctx.principal.tenantId,
            workspaceId: input.id,
            userId: input.userId,
            role: input.role,
          })
          .onConflictDoUpdate({
            target: [schema.workspaceMembers.workspaceId, schema.workspaceMembers.userId],
            set: { role: input.role },
          });
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'workspace.member_added', {
          workspaceId: input.id,
          userId: input.userId,
          role: input.role,
        });
      });
      const t = workspaceMemberTuples(input.id, input.userId, input.role);
      await ctx.deps.fga.write([t.current], t.stale);
      return { workspaceId: input.id, userId: input.userId, role: input.role };
    }),

  removeMember: procedure
    .input(z.object({ id: Uuid, userId: Uuid }))
    .mutation(async ({ ctx, input }) => {
      await requireRelation(ctx, 'can_manage', fga.workspace(input.id));
      const [membership] = await ctx.db((db) =>
        db
          .select()
          .from(schema.workspaceMembers)
          .where(and(eq(schema.workspaceMembers.workspaceId, input.id), eq(schema.workspaceMembers.userId, input.userId))),
      );
      if (!membership) throw new ProblemError(problems.notFound('not a member'));
      if (membership.role === 'owner') {
        const [owners] = await ctx.db((db) =>
          db
            .select({ n: count() })
            .from(schema.workspaceMembers)
            .where(and(eq(schema.workspaceMembers.workspaceId, input.id), eq(schema.workspaceMembers.role, 'owner'))),
        );
        if ((owners?.n ?? 0) <= 1) {
          throw new ProblemError(problems.preconditionFailed('a workspace must keep at least one owner'));
        }
      }

      // REVOKE: tuples first, then the row.
      await ctx.deps.fga.write([], workspaceMemberTuples(input.id, input.userId, 'member').all);
      await ctx.db(async (db) => {
        await db
          .delete(schema.workspaceMembers)
          .where(and(eq(schema.workspaceMembers.workspaceId, input.id), eq(schema.workspaceMembers.userId, input.userId)));
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'workspace.member_removed', {
          workspaceId: input.id,
          userId: input.userId,
        });
      });
      return { ok: true as const };
    }),
});
