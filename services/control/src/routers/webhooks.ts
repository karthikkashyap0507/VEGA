import { randomBytes } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { schedWebhookAgent, schema } from '@vega/db';
import { Uuid } from '@vega/contracts';
import { problems } from '@vega/shared';
import { createRun, hashSecret, loadAgentSpec, sealText } from '../agent/coordinator.js';
import { emitEvent } from '../lib.js';
import { ProblemError, procedure, requireCapability, router, webhookProcedure } from '../trpc.js';
import { refusal } from './runs.js';

/**
 * Webhooks both ways (docs/module4.md §7).
 *
 * OUTBOUND — endpoints a tenant admin registers for event kinds (run.started, run.completed …;
 * later modules add theirs). Delivery is the coordinator's (HMAC-signed, retried, through the
 * isolated web-fetch service). The signing secret is shown once, then only sealed.
 *
 * INBOUND — an agent's webhook trigger. The caller proves nothing but possession of the agent's
 * webhook secret; the body it sends is UNTRUSTED content bound as `trigger_payload`, and the
 * run's objective is the agent's own template (§5.1 rule 1).
 */

export const WEBHOOK_EVENT_KINDS = ['run.created', 'run.started', 'run.completed', 'run.failed', 'run.awaiting_input', 'run.replanned', 'run.needs_attention', 'run.status'] as const;

const endpointView = (e: typeof schema.webhookEndpoints.$inferSelect) => ({
  id: e.id,
  url: e.url,
  eventKinds: e.eventKinds,
  active: e.active,
  createdAt: e.createdAt.toISOString(),
});

export const webhooksRouter = router({
  list: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'tenant.update');
    const rows = await ctx.db((db) => db.select().from(schema.webhookEndpoints).orderBy(desc(schema.webhookEndpoints.createdAt)));
    return { items: rows.map(endpointView), eventKinds: [...WEBHOOK_EVENT_KINDS] };
  }),

  create: procedure
    .input(z.object({ url: z.string().url().max(2048).startsWith('https://', 'webhook URLs must be https'), eventKinds: z.array(z.enum(WEBHOOK_EVENT_KINDS)).min(1).max(WEBHOOK_EVENT_KINDS.length) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'tenant.update');
      const secret = `whsec_${randomBytes(24).toString('base64url')}`;
      // Start from now: an endpoint receives what happens after it exists, not the history.
      const [row] = await ctx.db(async (db) => {
        const [last] = await db.select({ id: schema.platformEvents.id }).from(schema.platformEvents).orderBy(desc(schema.platformEvents.id)).limit(1);
        const created = await db
          .insert(schema.webhookEndpoints)
          .values({ tenantId: ctx.principal.tenantId, url: input.url, eventKinds: [...new Set(input.eventKinds)], secretSealed: sealText(secret), createdBy: ctx.principal.userId, lastEventId: last?.id ?? 0n })
          .returning();
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'webhook.endpoint_created', { endpointId: created[0]!.id, url: input.url, eventKinds: input.eventKinds });
        return created;
      });
      return { endpoint: endpointView(row!), secret };
    }),

  remove: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'tenant.update');
    const removed = await ctx.db((db) => db.update(schema.webhookEndpoints).set({ active: false }).where(eq(schema.webhookEndpoints.id, input.id)).returning());
    if (!removed.length) throw new ProblemError(problems.notFound('endpoint not found'));
    return endpointView(removed[0]!);
  }),

  deliveries: procedure.input(z.object({ endpointId: Uuid.optional(), limit: z.number().int().min(1).max(200).default(50) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'tenant.update');
    const rows = await ctx.db((db) =>
      db
        .select()
        .from(schema.webhookDeliveries)
        .where(and(input.endpointId ? eq(schema.webhookDeliveries.endpointId, input.endpointId) : undefined))
        .orderBy(desc(schema.webhookDeliveries.createdAt))
        .limit(input.limit),
    );
    return {
      items: rows.map((d) => ({ id: d.id, endpointId: d.endpointId, eventId: d.eventId.toString(), kind: d.kind, status: d.status, attempts: d.attempts, lastStatus: d.lastStatus, lastError: d.lastError, nextAt: d.nextAt.toISOString(), createdAt: d.createdAt.toISOString() })),
    };
  }),
});

/** Inbound agent triggers, reachable only by the gateway's `webhook` system principal. */
export const triggersRouter = router({
  webhook: webhookProcedure
    .input(z.object({ agentId: Uuid, secret: z.string().min(20).max(200), payload: z.unknown() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = await schedWebhookAgent(input.agentId, hashSecret(input.secret));
      // One answer for "no such agent", "wrong secret" and "not active": nothing to enumerate.
      if (!tenantId) throw new ProblemError(problems.unauthorized('unknown agent or secret'));
      const agent = ctx.deps.agent;
      if (!agent) throw new ProblemError(problems.upstreamUnavailable('agent core'));
      const size = JSON.stringify(input.payload ?? null).length;
      if (size > 64 * 1024) throw new ProblemError(problems.validation([{ path: 'payload', message: 'payload larger than 64 KiB' }]));
      try {
        const { agent: row } = await loadAgentSpec(tenantId, input.agentId);
        const run = await createRun(agent.core, { tenantId, agentId: input.agentId, principalUserId: row.ownerUserId, trigger: 'webhook', triggerPayload: input.payload ?? null });
        agent.coordinator.kick(tenantId, run.id);
        return { runId: run.id, status: run.status };
      } catch (e) {
        return refusal(e);
      }
    }),
});
