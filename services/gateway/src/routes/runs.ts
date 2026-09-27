import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SYSTEM_TENANT } from '@vega/idp';
import { AgentSpec, RunDecision, RunInput, RunStatus, TERMINAL_RUN_STATUSES, Uuid } from '@vega/contracts';
import type { GatewayDeps } from '../app.js';
import { defineRoute, type RouteHooks } from '../http.js';

/**
 * The agent core's public surface — docs/module4.md §7: runs (and their live stream), agent
 * specs and dry runs, chat conversations, outbound webhook endpoints, and the inbound agent
 * webhook trigger. There is still no route that executes a tool directly.
 */
export function registerRunRoutes(app: FastifyInstance, hooks: RouteHooks, deps: GatewayDeps): void {
  const Id = z.object({ id: Uuid });

  // ------------------------------------------------------------------ runs
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/runs',
    summary: 'Start a run: objective → intent (C1) → plan (C2) → durable execution (C5)',
    tags: ['runs'],
    body: z.object({ agentId: Uuid, objective: z.string().trim().min(1).max(4000), conversationId: Uuid.optional() }),
    successStatus: 202,
    handler: ({ control, body }) => control.runs.create.mutate(body),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/runs',
    summary: 'Runs, newest first (filter by status, agent, workspace, conversation)',
    tags: ['runs'],
    query: z.object({
      status: z
        .string()
        .transform((s) => s.split(','))
        .pipe(z.array(RunStatus))
        .optional(),
      agentId: Uuid.optional(),
      workspaceId: Uuid.optional(),
      conversationId: Uuid.optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    }),
    handler: ({ control, query }) => control.runs.list.query(query as never),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/runs/:id',
    summary: 'A run with its task nodes, actions, program versions and replans',
    tags: ['runs'],
    params: Id,
    handler: ({ control, params }) => control.runs.get.query(params),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/runs/:id/program',
    summary: 'The program (AST and text) of a version, current by default',
    tags: ['runs'],
    params: Id,
    query: z.object({ version: z.coerce.number().int().min(1).optional() }),
    handler: ({ control, params, query }) => control.runs.program.query({ ...params, ...(query.version ? { version: query.version } : {}) }),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/runs/:id/replans',
    summary: 'Every replan of the run, with its cause',
    tags: ['runs'],
    params: Id,
    handler: ({ control, params }) => control.runs.replans.query(params),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/runs/:id/cancel',
    summary: 'Cancel: pending steps never run',
    tags: ['runs'],
    params: Id,
    body: z.object({ reason: z.string().max(500).optional() }).optional(),
    successStatus: 200,
    handler: ({ control, params, body }) => control.runs.cancel.mutate({ ...params, ...(body?.reason ? { reason: body.reason } : {}) }),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/runs/:id/input',
    summary: 'Answer a blocking clarification',
    tags: ['runs'],
    params: Id,
    body: RunInput,
    successStatus: 200,
    handler: ({ control, params, body }) => control.runs.input.mutate({ ...params, ...body }),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/runs/:id/decision',
    summary: 'Approve or reject the action the run is waiting on',
    tags: ['runs'],
    params: Id,
    body: RunDecision,
    successStatus: 200,
    handler: ({ control, params, body }) => control.runs.decide.mutate({ ...params, ...body } as never),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/runs/:id/release',
    summary: 'A held action (policy hold window): run it now',
    tags: ['runs'],
    params: Id,
    successStatus: 200,
    handler: ({ control, params }) => control.runs.release.mutate(params),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/runs/:id/revoke',
    summary: 'A held action: cancel it inside its window — it never happens',
    tags: ['runs'],
    params: Id,
    successStatus: 200,
    handler: ({ control, params }) => control.runs.revoke.mutate(params),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/runs/:id/resume',
    summary: 'Resume a run waiting on a connector or a credential',
    tags: ['runs'],
    params: Id,
    successStatus: 200,
    handler: ({ control, params }) => control.runs.resume.mutate(params),
  });

  // Server-sent events: the run's progress, polled from the control plane and pushed as it moves.
  app.route({
    method: 'GET',
    url: '/v1/runs/:id/stream',
    schema: { summary: 'Run progress as server-sent events (intent → plan → steps → result)', tags: ['runs'], security: [{ sessionCookie: [] }, { bearer: [] }] },
    preHandler: [hooks.authenticate, hooks.rateLimit],
    handler: async (req, reply) => {
      const parsed = Id.safeParse(req.params);
      if (!parsed.success) return reply.code(400).send({ type: 'about:blank', title: 'invalid run id', status: 400 });
      const control = req.control!;
      let after = String((req.headers['last-event-id'] as string | undefined) ?? (req.query as { after?: string }).after ?? '0').replace(/\D/g, '') || '0';
      // First read before switching to a stream: an unknown or forbidden run is a plain error.
      const first = await control.runs.events.query({ id: parsed.data.id, after });
      reply.hijack();
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      let closed = false;
      req.raw.on('close', () => (closed = true));
      const send = (id: string | null, event: string, data: unknown) => {
        if (closed) return;
        reply.raw.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      send(null, 'run', first.run);
      let lastStatus = first.run.status;
      let batch = first;
      const started = Date.now();
      while (!closed && Date.now() - started < 10 * 60_000) {
        for (const e of batch.events) {
          send(e.id, e.kind, e.payload);
          after = e.id;
        }
        if (batch.run.status !== lastStatus || batch.events.length) {
          send(null, 'run', batch.run);
          lastStatus = batch.run.status;
        }
        if (TERMINAL_RUN_STATUSES.has(batch.run.status)) break;
        await new Promise((r) => setTimeout(r, 700));
        if (closed) break;
        try {
          batch = await control.runs.events.query({ id: parsed.data.id, after });
        } catch {
          send(null, 'error', { title: 'stream interrupted' });
          break;
        }
        reply.raw.write(': keep-alive\n\n');
      }
      send(null, 'end', { status: batch.run.status });
      reply.raw.end();
    },
  });

  // ------------------------------------------------------------------ agents (Agent Studio)
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/agents/:id/spec',
    summary: "An agent's current spec, its version and the version history",
    tags: ['agents'],
    params: Id,
    handler: ({ control, params }) => control.agents.spec.query(params),
  });

  defineRoute(app, hooks, {
    method: 'PUT',
    url: '/v1/agents/:id/spec',
    summary: 'Save a spec: creates a new agent version (autonomy stays SHADOW until Module 10)',
    tags: ['agents'],
    params: Id,
    body: AgentSpec,
    handler: ({ control, params, body }) => control.agents.putSpec.mutate({ ...params, spec: body }),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/agents/:id/test',
    summary: 'Dry run: understand, plan and simulate an objective — no side effects',
    tags: ['agents'],
    params: Id,
    body: z.object({ objective: z.string().trim().min(1).max(4000) }),
    successStatus: 200,
    handler: ({ control, params, body }) => control.agents.test.mutate({ ...params, ...body }),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/agents/:id/webhook-secret',
    summary: 'Rotate the webhook-trigger secret (shown once)',
    tags: ['agents'],
    params: Id,
    handler: ({ control, params }) => control.agents.rotateWebhookSecret.mutate(params),
  });

  // Inbound: the caller has no session, only the agent's webhook secret.
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/hooks/agents/:id',
    summary: "Trigger an agent's webhook: the body is untrusted input, never an instruction",
    tags: ['agents'],
    auth: false,
    params: Id,
    body: z.unknown(),
    successStatus: 202,
    handler: async ({ req, params, body }) => {
      const header = req.headers.authorization ?? '';
      const secret = header.startsWith('Bearer ') ? header.slice(7) : String(req.headers['x-agent-webhook-secret'] ?? '');
      const control = deps.controlFor({ tenantId: SYSTEM_TENANT, userId: 'system:webhook', system: 'webhook' });
      return control.triggers.webhook.mutate({ agentId: params.id, secret, payload: body ?? null });
    },
  });

  // ------------------------------------------------------------------ conversations (chat)
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/conversations',
    summary: 'Your chat threads',
    tags: ['chat'],
    query: z.object({ agentId: Uuid.optional() }),
    handler: ({ control, query }) => control.conversations.list.query(query as never),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/conversations',
    summary: 'Start a thread with an agent',
    tags: ['chat'],
    body: z.object({ agentId: Uuid, title: z.string().trim().min(1).max(200).optional() }),
    handler: ({ control, body }) => control.conversations.create.mutate(body),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/conversations/:id',
    summary: 'A thread: messages and the runs they started',
    tags: ['chat'],
    params: Id,
    handler: ({ control, params }) => control.conversations.get.query(params),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/conversations/:id/messages',
    summary: 'Send a message: it becomes the objective of a new run',
    tags: ['chat'],
    params: Id,
    body: z.object({ text: z.string().trim().min(1).max(4000) }),
    handler: ({ control, params, body }) => control.conversations.send.mutate({ ...params, ...body }),
  });

  // ------------------------------------------------------------------ outbound webhooks
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/webhooks',
    summary: 'Webhook endpoints and the event kinds they can subscribe to',
    tags: ['webhooks'],
    handler: ({ control }) => control.webhooks.list.query(),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/webhooks',
    summary: 'Register an https endpoint (the signing secret is returned once)',
    tags: ['webhooks'],
    body: z.object({ url: z.string().url().max(2048), eventKinds: z.array(z.string()).min(1).max(20) }),
    handler: ({ control, body }) => control.webhooks.create.mutate(body as never),
  });

  defineRoute(app, hooks, {
    method: 'DELETE',
    url: '/v1/webhooks/:id',
    summary: 'Stop delivering to an endpoint',
    tags: ['webhooks'],
    params: Id,
    handler: ({ control, params }) => control.webhooks.remove.mutate(params),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/webhooks/deliveries',
    summary: 'Recent deliveries and their outcome',
    tags: ['webhooks'],
    query: z.object({ endpointId: Uuid.optional(), limit: z.coerce.number().int().min(1).max(200).optional() }),
    handler: ({ control, query }) => control.webhooks.deliveries.query(query as never),
  });
}
