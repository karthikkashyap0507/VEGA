import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Program } from '@vega/dsl';
import type { Orchestrator } from '@vega/orchestration';
import type { RunStore } from '@vega/runs';
import { runInputs } from '../executor/workflow.js';
import { programBlastRadius, type BlastDeps } from './blast.js';
import type { ReversibilityEngine, RollbackOutcome } from './engine.js';

/**
 * Internal undo API — the control plane's way to run a compensation (docs/module6.md §7). The
 * control plane authorizes the person, checks the undo is still possible and that the
 * consequence was confirmed; here it becomes a rollback row (the order is fixed now) and a
 * durable workflow that runs it:
 *
 *   POST /internal/rollbacks        { tenantId, runId, scope, compensationId?, requestedBy, requestedAt }
 *   GET  /internal/rollbacks/:id    ?tenantId=… — the workflow's result once it has one
 *   POST /internal/blast-radius     { tenantId, runId } — re-simulate the current program (§7 refresh)
 */
export const ROLLBACK_WORKFLOW = 'vega.rollback';

export interface RollbackArgs {
  tenantId: string;
  rollbackId: string;
  agentId?: string | undefined;
}

export function rollbackWorkflow(engine: ReversibilityEngine) {
  return async (ctx: Parameters<ReversibilityEngine['rollback']>[0], args: RollbackArgs): Promise<RollbackOutcome> => engine.rollback(ctx, args.tenantId, args.rollbackId, { agentId: args.agentId });
}

const Body = z.object({
  tenantId: z.string().uuid(),
  runId: z.string().uuid(),
  scope: z.enum(['action', 'run']),
  compensationId: z.string().uuid().optional(),
  requestedBy: z.string().uuid(),
  requestedAt: z.string().datetime({ offset: true }),
  agentId: z.string().uuid().optional(),
});

function authorized(req: FastifyRequest, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

export function registerRollbackApi(app: FastifyInstance, deps: { engine: ReversibilityEngine; orchestrator: Orchestrator; token: string; blast?: { deps: BlastDeps; runs: RunStore } | undefined }): void {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/internal/rollbacks') && !req.url.startsWith('/internal/blast-radius')) return;
    if (!authorized(req, deps.token)) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'service token required' } });
  });

  app.post('/internal/rollbacks', async (req, reply) => {
    const input = Body.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.error.message } });
    const b = input.data;
    const rb = await deps.engine.plan(b.tenantId, { runId: b.runId, scope: b.scope, trigger: 'user', requestedBy: b.requestedBy, requestedAt: new Date(b.requestedAt), compensationId: b.compensationId });
    if (!rb.compensationIds.length) return reply.code(409).send({ error: { code: 'CONFLICT', message: 'there is nothing left to undo' }, rollbackId: rb.id });
    await deps.orchestrator.start<[RollbackArgs]>(ROLLBACK_WORKFLOW, rb.id, { tenantId: b.tenantId, rollbackId: rb.id, agentId: b.agentId });
    return reply.code(202).send({ rollbackId: rb.id, compensations: rb.compensationIds });
  });

  app.get('/internal/rollbacks/:id', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const tenantId = (req.query as { tenantId?: string }).tenantId ?? '';
    if (!z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(tenantId).success) return reply.code(400).send({ error: { code: 'VALIDATION', message: 'ids' } });
    const row = await deps.engine.deps.store.rollback(tenantId, id);
    if (!row) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'rollback not found' } });
    return { rollback: row, workflow: await deps.orchestrator.status(id) };
  });

  app.post('/internal/blast-radius', async (req, reply) => {
    const input = z.object({ tenantId: z.string().uuid(), runId: z.string().uuid() }).safeParse(req.body);
    if (!input.success || !deps.blast) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.success ? 'blast radius is not available here' : input.error.message } });
    const { tenantId, runId } = input.data;
    const run = await deps.blast.runs.load(tenantId, runId);
    const program = run ? await deps.blast.runs.program(tenantId, runId, run.programVersion) : null;
    if (!run || !program) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'run or program not found' } });
    const out = await programBlastRadius(deps.blast.deps, { tenantId, runId, bindings: run.checkpoint.bindings, program: program.ast as Program, modelId: program.modelId, now: new Date().toISOString(), inputs: runInputs(run), maxCollection: run.spec.limits.maxFanout });
    const id = await deps.engine.deps.store.saveBlastRadius(tenantId, { runId, programVersion: program.version, programDigest: program.digest, effects: out.effects, summary: out.summary });
    return { id, programVersion: program.version, summary: out.summary };
  });
}
