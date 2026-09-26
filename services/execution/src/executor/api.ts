import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TERMINAL_RUN_STATUSES } from '@vega/contracts';
import { RunTokenError, type VerifiedRunToken } from '@vega/idp';
import type { Orchestrator } from '@vega/orchestration';
import { TransitionError, type Grant, type RunStore } from '@vega/runs';
import type { ExecutorLog } from './pass.js';
import { RUN_WORKFLOW, TOPICS, type RunArgs } from './workflow.js';

/**
 * Internal run API — the control plane's only way to drive the executor (docs/module4.md §3):
 *
 *   POST /internal/runs/start    a PLANNED run + its run token → the durable workflow starts
 *   POST /internal/runs/signal   decision · input · program · resume, optionally with a fresh token
 *   POST /internal/runs/cancel   stop now: pending steps never run
 *   GET  /internal/runs/:id      engine status (operators; the durability suite)
 *
 * The run token is verified here, once, against the control plane's JWKS; the workflow keeps
 * only its verified claims (scopes, expiry) and checks them on every call. The token itself is
 * never persisted.
 */

export interface RunTokenCheck {
  verify(token: string): Promise<VerifiedRunToken>;
}

export interface RunApiDeps {
  orchestrator: Orchestrator;
  store: RunStore;
  token: string;
  /** Absent only in development (loudly): calls are then not credential-checked. */
  runTokens?: RunTokenCheck | undefined;
  log: ExecutorLog;
}

const Ref = z.object({ tenantId: z.string().uuid(), runId: z.string().uuid() });
const Start = Ref.extend({ token: z.string().max(4000).optional() });
const Signal = Ref.extend({
  topic: z.enum([TOPICS.decision, TOPICS.input, TOPICS.program, TOPICS.resume]),
  message: z.record(z.string(), z.unknown()),
  token: z.string().max(4000).optional(),
});
const Cancel = Ref.extend({ by: z.string().uuid().optional(), reason: z.string().max(500).optional() });

function authorized(req: FastifyRequest, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function registerRunApi(app: FastifyInstance, deps: RunApiDeps): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/internal/runs')) return;
    if (!authorized(req, deps.token)) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'service token required' } });
  });

  /** Verifies a run token for exactly this tenant and run; stores its claims (never the token). */
  const acceptToken = async (tenantId: string, runId: string, token: string | undefined): Promise<{ ok: true } | { ok: false; message: string }> => {
    if (!token) return deps.runTokens ? { ok: false, message: 'a run token is required' } : { ok: true };
    if (!deps.runTokens) return { ok: true };
    try {
      const v = await deps.runTokens.verify(token);
      if (v.tenantId !== tenantId || v.runId !== runId) return { ok: false, message: 'run token is for a different run' };
      const grant: Grant = { scopes: v.scopes, expiresAt: v.expiresAt.toISOString(), jti: v.jti };
      await deps.store.updateCheckpoint(tenantId, runId, (cp) => ({ ...cp, grant }));
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof RunTokenError ? e.message : 'run token rejected' };
    }
  };

  app.post('/internal/runs/start', async (req, reply) => {
    const input = Start.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.error.message } });
    const { tenantId, runId, token } = input.data;
    const run = await deps.store.view(tenantId, runId);
    if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'run not found' } });
    if (run.status !== 'PLANNED') return reply.code(409).send({ error: { code: 'CONFLICT', message: `run is ${run.status}, not PLANNED` } });
    const t = await acceptToken(tenantId, runId, token);
    if (!t.ok) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: t.message } });
    // The workflow id IS the run id: starting the same run twice is a no-op in the engine.
    await deps.orchestrator.start<[RunArgs]>(RUN_WORKFLOW, runId, { tenantId, runId });
    deps.log.info({ run_id: runId }, 'run workflow started');
    return reply.code(202).send({ started: true, workflowId: runId });
  });

  app.post('/internal/runs/signal', async (req, reply) => {
    const input = Signal.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.error.message } });
    const { tenantId, runId, topic, message, token } = input.data;
    const run = await deps.store.view(tenantId, runId);
    if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'run not found' } });
    if (TERMINAL_RUN_STATUSES.has(run.status)) return reply.code(409).send({ error: { code: 'CONFLICT', message: `run is ${run.status}` } });
    if (token) {
      const t = await acceptToken(tenantId, runId, token);
      if (!t.ok) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: t.message } });
    }
    await deps.orchestrator.send(runId, topic, message);
    return reply.code(202).send({ delivered: true });
  });

  app.post('/internal/runs/cancel', async (req, reply) => {
    const input = Cancel.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.error.message } });
    const { tenantId, runId, by, reason } = input.data;
    const run = await deps.store.view(tenantId, runId);
    if (!run) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'run not found' } });
    if (TERMINAL_RUN_STATUSES.has(run.status)) return { status: run.status };
    // Cancel the engine first (no further steps start), then the record.
    if (await deps.orchestrator.status(runId)) await deps.orchestrator.cancel(runId);
    try {
      await deps.store.setStatus(tenantId, runId, 'CANCELLED', { reason: reason ?? 'cancelled', actorId: by ?? null });
    } catch (e) {
      if (!(e instanceof TransitionError)) throw e;
    }
    await deps.store.skipPending(tenantId, runId);
    return { status: 'CANCELLED' };
  });

  app.get('/internal/runs/:runId', async (req, reply) => {
    const runId = (req.params as { runId: string }).runId;
    if (!z.string().uuid().safeParse(runId).success) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'run id' } });
    return { workflowId: runId, status: await deps.orchestrator.status(runId) };
  });
}
