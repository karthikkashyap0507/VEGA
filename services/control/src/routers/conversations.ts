import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { fga } from '@vega/authz';
import { schema } from '@vega/db';
import { Uuid } from '@vega/contracts';
import { problems } from '@vega/shared';
import { createRun } from '../agent/coordinator.js';
import { ProblemError, procedure, requireCapability, requireRelation, router, type AuthedContext } from '../trpc.js';
import { agentCore, refusal } from './runs.js';

/**
 * Conversations — the chat surface (docs/module4.md §6.1). A thread belongs to one user and one
 * agent. Every message the user sends becomes a run whose objective is that message: the
 * principal typed it, so it is TRUSTED. The agent's side of the thread is the run itself —
 * progress, action cards and results — linked from an `agent` message.
 */

async function own(ctx: AuthedContext, id: string) {
  const [c] = await ctx.db((db) => db.select().from(schema.conversations).where(eq(schema.conversations.id, id)));
  if (!c || c.userId !== ctx.principal.userId) throw new ProblemError(problems.notFound('conversation not found'));
  return c;
}

const view = (c: typeof schema.conversations.$inferSelect) => ({ id: c.id, agentId: c.agentId, workspaceId: c.workspaceId, title: c.title, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() });

export const conversationsRouter = router({
  list: procedure.input(z.object({ agentId: Uuid.optional(), limit: z.number().int().min(1).max(100).default(50) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const rows = await ctx.db((db) =>
      db
        .select()
        .from(schema.conversations)
        .where(and(eq(schema.conversations.userId, ctx.principal.userId), input.agentId ? eq(schema.conversations.agentId, input.agentId) : undefined))
        .orderBy(desc(schema.conversations.updatedAt))
        .limit(input.limit),
    );
    return { items: rows.map(view) };
  }),

  create: procedure.input(z.object({ agentId: Uuid, title: z.string().trim().min(1).max(200).optional() })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.run');
    await requireRelation(ctx, 'can_run', fga.agent(input.agentId));
    const [agent] = await ctx.db((db) => db.select().from(schema.agents).where(eq(schema.agents.id, input.agentId)));
    if (!agent) throw new ProblemError(problems.notFound('agent not found'));
    const [c] = await ctx.db((db) =>
      db
        .insert(schema.conversations)
        .values({ tenantId: ctx.principal.tenantId, workspaceId: agent.workspaceId, agentId: agent.id, userId: ctx.principal.userId, ...(input.title ? { title: input.title } : {}) })
        .returning(),
    );
    return view(c!);
  }),

  get: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    const c = await own(ctx, input.id);
    const { core } = agentCore(ctx);
    const messages = await ctx.db((db) => db.select().from(schema.conversationMessages).where(eq(schema.conversationMessages.conversationId, c.id)).orderBy(asc(schema.conversationMessages.createdAt)));
    const runs = await core.store.list(ctx.principal.tenantId, { conversationId: c.id, limit: 200 });
    return {
      conversation: view(c),
      messages: messages.map((m) => ({ id: m.id, role: m.role, body: m.body, runId: m.runId, createdAt: m.createdAt.toISOString() })),
      runs,
    };
  }),

  send: procedure.input(z.object({ id: Uuid, text: z.string().trim().min(1).max(4000) })).mutation(async ({ ctx, input }) => {
    const c = await own(ctx, input.id);
    requireCapability(ctx, 'agents.run');
    await requireRelation(ctx, 'can_run', fga.agent(c.agentId));
    const { core, coordinator } = agentCore(ctx);
    const [userMsg] = await ctx.db((db) =>
      db.insert(schema.conversationMessages).values({ tenantId: ctx.principal.tenantId, conversationId: c.id, role: 'user', body: input.text }).returning(),
    );
    let run;
    try {
      run = await createRun(core, { tenantId: ctx.principal.tenantId, agentId: c.agentId, principalUserId: ctx.principal.userId, trigger: 'chat', objective: input.text, conversationId: c.id });
    } catch (e) {
      await ctx.db((db) =>
        db.insert(schema.conversationMessages).values({ tenantId: ctx.principal.tenantId, conversationId: c.id, role: 'system', body: e instanceof Error ? e.message : 'the run could not start' }),
      );
      return refusal(e);
    }
    await ctx.db(async (db) => {
      await db.insert(schema.conversationMessages).values({ tenantId: ctx.principal.tenantId, conversationId: c.id, role: 'agent', body: '', runId: run.id });
      await db
        .update(schema.conversations)
        .set({ updatedAt: new Date(), ...(c.title === 'New conversation' ? { title: input.text.slice(0, 80) } : {}) })
        .where(eq(schema.conversations.id, c.id));
    });
    coordinator.kick(run.tenantId, run.id);
    return { message: { id: userMsg!.id, role: 'user', body: input.text, runId: null, createdAt: userMsg!.createdAt.toISOString() }, run };
  }),
});
