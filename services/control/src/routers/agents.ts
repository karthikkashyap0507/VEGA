import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { Cron } from 'croner';
import { z } from 'zod';
import { problems } from '@vega/shared';
import { schema } from '@vega/db';
import { AgentSpec, AgentStatus, CreateAgent, PageQuery, UpdateAgent, Uuid } from '@vega/contracts';
import { callBound, parse, ParseError, print } from '@vega/dsl';
import type { LoadedRun } from '@vega/runs';
import { bindConnectors, hashSecret, loadAgentSpec } from '../agent/coordinator.js';
import { understand } from '../agent/intent.js';
import { planRun } from '../agent/planning.js';
import { agentCore, refusal } from './runs.js';
import { agentCreatedTuples, agentOwnerChangeTuples, fga, hasCapability } from '@vega/authz';
import {
  ProblemError,
  procedure,
  requireCapability,
  requireRelation,
  router,
  type AuthedContext,
} from '../trpc.js';
import { afterCursor, decodeCursor, emitEvent, isUniqueViolation, newestFirst, page, toAgent } from '../lib.js';

/**
 * Agents — module1.md §8.2. Agents are PRINCIPALS: each one gets its own Zitadel machine
 * user, distinct from its owner and from every other agent. A run later acts as the agent
 * on behalf of a user, and both identities land on every receipt (M7).
 *
 * An agent is created in `draft` and becomes `active` when its first spec is saved (Module 4).
 */

async function loadAgent(ctx: AuthedContext, id: string) {
  const [row] = await ctx.db((db) => db.select().from(schema.agents).where(eq(schema.agents.id, id)));
  if (!row) throw new ProblemError(problems.notFound('agent not found'));
  return row;
}

async function requireActiveTenantUser(ctx: AuthedContext, userId: string) {
  const [user] = await ctx.db((db) => db.select().from(schema.users).where(eq(schema.users.id, userId)));
  if (!user || user.status !== 'active') {
    throw new ProblemError(problems.preconditionFailed('owner must be an active user in this tenant'));
  }
  return user;
}

function hasSpec(spec: unknown): boolean {
  return typeof spec === 'object' && spec !== null && Object.keys(spec).length > 0;
}

export const agentsRouter = router({
  list: procedure
    .input(PageQuery.extend({ workspaceId: Uuid.optional(), status: AgentStatus.optional() }))
    .query(async ({ ctx, input }) => {
      requireCapability(ctx, 'agents.read');
      if (input.workspaceId) await requireRelation(ctx, 'member', fga.workspace(input.workspaceId));
      const cursor = decodeCursor(input.cursor);
      const seesAll = hasCapability(ctx.principal.role, 'workspaces.manage');

      const rows = await ctx.db(async (db) => {
        const visible =
          seesAll || input.workspaceId
            ? undefined
            : (
                await db
                  .select({ id: schema.workspaceMembers.workspaceId })
                  .from(schema.workspaceMembers)
                  .where(eq(schema.workspaceMembers.userId, ctx.principal.userId))
              ).map((r) => r.id);
        if (visible && visible.length === 0) return [];
        return db
          .select()
          .from(schema.agents)
          .where(
            and(
              input.workspaceId ? eq(schema.agents.workspaceId, input.workspaceId) : undefined,
              visible ? inArray(schema.agents.workspaceId, visible) : undefined,
              input.status ? eq(schema.agents.status, input.status) : ne(schema.agents.status, 'archived'),
              afterCursor(schema.agents.createdAt, schema.agents.id, cursor),
            ),
          )
          .orderBy(...newestFirst(schema.agents.createdAt, schema.agents.id))
          .limit(input.limit + 1);
      });
      return page(rows, input.limit, toAgent);
    }),

  get: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const row = await loadAgent(ctx, input.id);
    await requireRelation(ctx, 'member', fga.workspace(row.workspaceId));
    return toAgent(row);
  }),

  /**
   * module1.md §8.2, in order, all-or-nothing:
   *   machine user → agents row → tuples → platform_event → status draft
   * A later failure compensates the earlier steps, so there is never an agent without a
   * distinct identity, nor an identity without an agent.
   */
  create: procedure.input(CreateAgent).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.create');
    await requireRelation(ctx, 'can_run_agent', fga.workspace(input.workspaceId));

    const ownerUserId = input.ownerUserId ?? ctx.principal.userId;
    if (ownerUserId !== ctx.principal.userId) {
      // Assigning an agent to someone else is workspace administration.
      await requireRelation(ctx, 'can_manage', fga.workspace(input.workspaceId));
      await requireActiveTenantUser(ctx, ownerUserId);
    }

    const [workspace] = await ctx.db((db) =>
      db.select().from(schema.workspaces).where(eq(schema.workspaces.id, input.workspaceId)),
    );
    if (!workspace || workspace.archivedAt) {
      throw new ProblemError(problems.preconditionFailed('workspace is missing or archived'));
    }
    const [tenant] = await ctx.db((db) =>
      db.select({ idpOrgId: schema.tenants.idpOrgId }).from(schema.tenants).where(eq(schema.tenants.id, ctx.principal.tenantId)),
    );
    if (!tenant?.idpOrgId) {
      throw new ProblemError(problems.preconditionFailed('tenant has no identity organization'));
    }

    const agentId = randomUUID();
    const machine = await ctx.deps.identity.createMachineUser({
      orgId: tenant.idpOrgId,
      // The agent id makes the username stable and collision-free, and ties the IdP object
      // back to our row without a lookup table.
      username: `agent-${agentId}`,
      name: input.name,
      description: `Agent ${agentId} in workspace ${input.workspaceId}`,
    });

    let row: typeof schema.agents.$inferSelect;
    try {
      row = await ctx.db(async (db) => {
        const [created] = await db
          .insert(schema.agents)
          .values({
            id: agentId,
            tenantId: ctx.principal.tenantId,
            workspaceId: input.workspaceId,
            name: input.name,
            ownerUserId,
            idpMachineId: machine.userId,
            status: 'draft',
          })
          .returning();
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'agent.created', {
          agentId,
          workspaceId: input.workspaceId,
          idpMachineId: machine.userId,
        });
        return created!;
      });
    } catch (error) {
      await ctx.deps.identity.deleteUser(machine.userId).catch((e: unknown) =>
        ctx.log.error({ err: e, machineId: machine.userId }, 'compensation failed: orphaned machine user'),
      );
      if (isUniqueViolation(error)) {
        throw new ProblemError(problems.conflict('an agent with this name already exists in the workspace'));
      }
      throw error;
    }

    try {
      await ctx.deps.fga.write(
        agentCreatedTuples({
          agentId,
          workspaceId: input.workspaceId,
          tenantId: ctx.principal.tenantId,
          ownerUserId,
        }),
      );
    } catch (error) {
      ctx.log.error({ err: error }, 'tuple write failed creating agent; compensating');
      await ctx.db((db) => db.delete(schema.agents).where(eq(schema.agents.id, agentId)));
      await ctx.deps.identity.deleteUser(machine.userId).catch(() => undefined);
      throw new ProblemError(problems.upstreamUnavailable('authorization'));
    }
    return toAgent(row);
  }),

  update: procedure.input(UpdateAgent.extend({ id: Uuid })).mutation(async ({ ctx, input }) => {
    const current = await loadAgent(ctx, input.id);
    await requireRelation(ctx, 'can_manage', fga.agent(input.id));

    if (input.status === 'active' && !hasSpec(current.specJson)) {
      throw new ProblemError(
        problems.preconditionFailed('an agent cannot be activated before it has a spec: save one in Agent Studio'),
      );
    }
    if (input.status === 'archived') {
      throw new ProblemError(problems.validation([{ path: 'status', message: 'use DELETE to archive an agent' }]));
    }
    if (current.status === 'archived') {
      throw new ProblemError(problems.preconditionFailed('archived agents cannot be modified'));
    }

    const ownerChanging = input.ownerUserId !== undefined && input.ownerUserId !== current.ownerUserId;
    if (ownerChanging) {
      await requireRelation(ctx, 'can_manage', fga.workspace(current.workspaceId));
      await requireActiveTenantUser(ctx, input.ownerUserId!);
    }

    let row: typeof schema.agents.$inferSelect;
    try {
      row = await ctx.db(async (db) => {
        const [updated] = await db
          .update(schema.agents)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.status !== undefined ? { status: input.status } : {}),
            ...(ownerChanging ? { ownerUserId: input.ownerUserId! } : {}),
          })
          .where(eq(schema.agents.id, input.id))
          .returning();
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'agent.updated', {
          agentId: input.id,
          fields: Object.keys(input).filter((k) => k !== 'id'),
        });
        return updated!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ProblemError(problems.conflict('an agent with this name already exists in the workspace'));
      }
      throw error;
    }

    if (ownerChanging) {
      const t = agentOwnerChangeTuples(input.id, current.ownerUserId, input.ownerUserId!);
      await ctx.deps.fga.write(t.writes, t.deletes);
    }
    return toAgent(row);
  }),

  // ------------------------------------------------------------------ Agent Studio (Module 4)
  spec: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const row = await loadAgent(ctx, input.id);
    await requireRelation(ctx, 'member', fga.workspace(row.workspaceId));
    const { spec, version } = await loadAgentSpec(ctx.principal.tenantId, row.id);
    const versions = await ctx.db((db) =>
      db
        .select({ version: schema.agentVersions.version, createdAt: schema.agentVersions.createdAt, createdBy: schema.agentVersions.createdBy })
        .from(schema.agentVersions)
        .where(eq(schema.agentVersions.agentId, row.id))
        .orderBy(desc(schema.agentVersions.version)),
    );
    return { agent: toAgent(row), spec, version, versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })), webhookConfigured: Boolean(row.webhookSecretHash) };
  }),

  /** PUT /v1/agents/:id/spec — every save is a new version; runs record the version they ran. */
  putSpec: procedure.input(z.object({ id: Uuid, spec: AgentSpec })).mutation(async ({ ctx, input }) => {
    const current = await loadAgent(ctx, input.id);
    await requireRelation(ctx, 'can_manage', fga.agent(input.id));
    if (current.status === 'archived') throw new ProblemError(problems.preconditionFailed('archived agents cannot be modified'));
    const { core } = agentCore(ctx);
    // Autonomy is displayed, never settable, until Module 10.
    const spec: AgentSpec = { ...input.spec, autonomy: 'SHADOW' };
    const issues: Array<{ path: string; message: string }> = [];
    const known = new Set((await core.execution.toolDeclarations(ctx.principal.tenantId, spec.allowedTools)).map((t) => t.toolId));
    spec.allowedTools.forEach((t, i) => !known.has(t) && issues.push({ path: `allowedTools.${i}`, message: `no tool ${t} in this tenant` }));
    spec.triggers.forEach((t, i) => {
      if (t.kind !== 'schedule') return;
      try {
        new Cron(t.cron, { timezone: t.tz });
      } catch (e) {
        issues.push({ path: `triggers.${i}.cron`, message: e instanceof Error ? e.message : 'invalid cron' });
      }
    });
    if (spec.triggers.some((t) => t.kind !== 'manual') && !spec.objectiveTemplate.trim()) issues.push({ path: 'objectiveTemplate', message: 'scheduled and webhook triggers need an objective template' });
    if (spec.program) {
      try {
        const p = parse(spec.program);
        const v = await core.execution.validateProgram(ctx.principal.tenantId, p, { maxCollection: spec.limits.maxFanout });
        for (const e of v.errors) issues.push({ path: 'program', message: `${e.code}: ${e.message}` });
        const bound = callBound(p, spec.limits.maxFanout);
        if (bound > spec.limits.maxSteps) issues.push({ path: 'program', message: `up to ${bound} tool calls; max_steps is ${spec.limits.maxSteps}` });
      } catch (e) {
        issues.push({ path: 'program', message: e instanceof ParseError ? e.message : String(e) });
      }
    }
    if (issues.length) throw new ProblemError(problems.validation(issues));
    const row = await ctx.db(async (db) => {
      const [latest] = await db.select({ v: schema.agentVersions.version }).from(schema.agentVersions).where(eq(schema.agentVersions.agentId, input.id)).orderBy(desc(schema.agentVersions.version)).limit(1);
      const version = latest ? latest.v + 1 : current.version;
      await db.insert(schema.agentVersions).values({ tenantId: ctx.principal.tenantId, agentId: input.id, version, specJson: spec, createdBy: ctx.principal.userId });
      const [updated] = await db
        .update(schema.agents)
        .set({ specJson: spec, version, ...(current.status === 'draft' ? { status: 'active' } : {}) })
        .where(eq(schema.agents.id, input.id))
        .returning();
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'agent.spec_saved', { agentId: input.id, version, tools: spec.allowedTools.length });
      return updated!;
    });
    return { agent: toAgent(row), spec, version: row.version };
  }),

  /**
   * POST /v1/agents/:id/test — a dry run: C1 and C2 for real, then the program in SIMULATE mode.
   * Reads execute (they have no effect); every write is simulated. Nothing leaves the building.
   */
  test: procedure.input(z.object({ id: Uuid, objective: z.string().trim().min(1).max(4000) })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.run');
    await requireRelation(ctx, 'can_run', fga.agent(input.id));
    const { core } = agentCore(ctx);
    try {
      const { agent, spec, version } = await loadAgentSpec(ctx.principal.tenantId, input.id);
      const objective = await understand({ tenantId: ctx.principal.tenantId, principalUserId: ctx.principal.userId, text: input.objective, origin: 'principal' }, core.mentions);
      const bindings = await bindConnectors(ctx.principal.tenantId, ctx.principal.userId, spec, core.registry);
      const runId = `test-${randomUUID()}`;
      const run: LoadedRun = {
        id: runId,
        tenantId: ctx.principal.tenantId,
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        agentVersion: version,
        principalUserId: ctx.principal.userId,
        conversationId: null,
        trigger: 'test',
        objective,
        status: 'PLANNING',
        statusReason: null,
        programVersion: 0,
        replanCount: 0,
        costCents: 0,
        pending: null,
        checkpoint: { bindings, approvals: [] },
        spec,
      };
      const plan = await planRun(run, core.planning);
      if (!plan.ok) return { objective, plan: { ok: false as const, reason: plan.reason, attempts: plan.attempts }, dryRun: null };
      const inputs = Object.fromEntries(
        objective.entities.map((e) => [e.binding, { data: { id: e.resolvedId, type: e.type, name: e.name ?? e.raw, email: e.email ?? null }, taint: 'TRUSTED' as const, sourceId: `entity:${e.binding}` }]),
      );
      const dryRun = await core.execution.runProgram({
        tenantId: ctx.principal.tenantId,
        runId,
        program: plan.program,
        mode: 'simulate',
        modelId: plan.modelId,
        now: new Date().toISOString(),
        bindings,
        objective: objective.objective,
        inputs,
        maxCollection: spec.limits.maxFanout,
      });
      return {
        objective,
        plan: { ok: true as const, text: print(plan.program), rows: plan.rows, blocking: plan.blocking, assumptions: plan.assumptions, source: plan.source, attempts: plan.attempts },
        dryRun,
      };
    } catch (e) {
      return refusal(e);
    }
  }),

  /** A new webhook-trigger secret, shown once. Only its hash is kept. */
  rotateWebhookSecret: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    await loadAgent(ctx, input.id);
    await requireRelation(ctx, 'can_manage', fga.agent(input.id));
    const secret = `agt_${randomBytes(24).toString('base64url')}`;
    await ctx.db(async (db) => {
      await db.update(schema.agents).set({ webhookSecretHash: hashSecret(secret) }).where(eq(schema.agents.id, input.id));
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'agent.webhook_secret_rotated', { agentId: input.id });
    });
    return { secret, path: `/v1/hooks/agents/${input.id}` };
  }),

  /**
   * DELETE /v1/agents/:id archives. The row and its machine identity are retained (and the
   * identity deactivated) because audit receipts reference both.
   */
  remove: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    const current = await loadAgent(ctx, input.id);
    await requireRelation(ctx, 'can_manage', fga.agent(input.id));
    if (current.status === 'archived') return toAgent(current);

    // REVOKE first: nobody can run it once this returns, whatever happens next.
    await ctx.deps.fga.write([], [{ user: `user:${current.ownerUserId}`, relation: 'owner', object: fga.agent(input.id) }, { user: fga.workspace(current.workspaceId), relation: 'workspace', object: fga.agent(input.id) }]);
    if (current.idpMachineId) {
      await ctx.deps.identity.deactivateUser(current.idpMachineId).catch((e: unknown) =>
        ctx.log.warn({ err: e }, 'machine user deactivation failed; agent is already unrunnable'),
      );
    }
    const row = await ctx.db(async (db) => {
      const [updated] = await db
        .update(schema.agents)
        .set({ status: 'archived' })
        .where(eq(schema.agents.id, input.id))
        .returning();
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'agent.archived', { agentId: input.id });
      return updated!;
    });
    return toAgent(row);
  }),
});
