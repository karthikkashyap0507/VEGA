import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Uuid } from '@vega/contracts';
import type { GatewayDeps } from '../app.js';
import { defineRoute, type RouteHooks } from '../http.js';

/**
 * Programs, provenance, taint violations and trusted contacts — docs/module3.md §4, §8.
 * Dry runs only: executing a program is the orchestrator's job (Module 4), never a public route.
 */
const ProgramInput = z.union([z.string().min(1).max(200_000), z.record(z.string(), z.unknown())]);

export function registerProgramRoutes(app: FastifyInstance, hooks: RouteHooks, _deps: GatewayDeps): void {
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/programs/catalog',
    summary: 'Extraction schemas and render templates available to programs',
    tags: ['programs'],
    handler: ({ control }) => control.programs.catalog.query(),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/programs/validate',
    summary: 'Static validation and taint inference, before anything runs',
    tags: ['programs'],
    body: z.object({ program: ProgramInput }),
    successStatus: 200,
    handler: ({ control, body }) => control.programs.validate.mutate(body as never),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/programs/dry-run',
    summary: 'Run a program in simulate mode: full gate, full provenance, no side effects',
    tags: ['programs'],
    body: z.object({ program: ProgramInput, objective: z.string().max(4000).optional(), bindings: z.record(z.string(), Uuid).optional() }),
    successStatus: 200,
    handler: ({ control, body }) => control.programs.dryRun.mutate(body as never),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/runs/:runId/provenance',
    summary: 'The provenance graph of a run: sources → derivations → actions',
    tags: ['programs'],
    params: z.object({ runId: z.string().min(1).max(200) }),
    handler: ({ control, params }) => control.programs.provenance.query(params),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/security/taint-violations',
    summary: 'Taint violations — security incidents, newest first',
    tags: ['security'],
    query: z.object({
      limit: z.coerce.number().int().min(1).max(200).optional(),
      before: z.string().datetime({ offset: true }).optional(),
      unacknowledged: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
    }),
    handler: ({ control, query }) => control.security.violations.query(query as never),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/security/taint-violations/:id/acknowledge',
    summary: 'Acknowledge a violation (it is never deleted)',
    tags: ['security'],
    params: z.object({ id: Uuid }),
    successStatus: 200,
    handler: ({ control, params }) => control.security.acknowledge.mutate(params),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/trusted-contacts',
    summary: 'The contacts `resolve … in contacts` may endorse',
    tags: ['security'],
    handler: ({ control }) => control.contacts.list.query(),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/trusted-contacts',
    summary: 'Trust a contact (recipients derived from content can only ever be one of these)',
    tags: ['security'],
    body: z.object({ email: z.string().email().max(320), displayName: z.string().max(200).optional(), company: z.string().max(200).optional() }),
    handler: ({ control, body }) => control.contacts.add.mutate(body),
  });

  defineRoute(app, hooks, {
    method: 'DELETE',
    url: '/v1/trusted-contacts/:id',
    summary: 'Stop trusting a contact',
    tags: ['security'],
    params: z.object({ id: Uuid }),
    handler: ({ control, params }) => control.contacts.remove.mutate(params),
  });
}
