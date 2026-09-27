import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Uuid } from '@vega/contracts';
import { SYSTEM_TENANT } from '@vega/idp';
import type { GatewayDeps } from '../app.js';
import { defineRoute, type RouteHooks } from '../http.js';

/**
 * The Reversibility Layer — docs/module6.md §7. Revoking is the fast, frictionless path (and
 * works from a push with no session); releasing early and editing need a signed-in person; an
 * undo that other people will see needs `confirm: true` (428 until then, with the consequence).
 */
export function registerReversibilityRoutes(app: FastifyInstance, hooks: RouteHooks, deps: GatewayDeps): void {
  const Id = z.object({ id: Uuid });
  const tags = ['reversibility'];

  // ------------------------------------------------------------ blast radius
  defineRoute(app, hooks, { method: 'GET', url: '/v1/runs/:id/blast-radius', summary: 'What the run will do: its simulated effects, grouped, with the weakest fidelity', tags, params: Id, handler: ({ control, params }) => control.undo.blastRadius.query({ runId: params.id }) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/runs/:id/blast-radius/refresh', summary: 'Re-simulate the run’s current program', tags, params: Id, successStatus: 200, handler: ({ control, params }) => control.undo.refreshBlastRadius.mutate({ runId: params.id }) });

  // ------------------------------------------------------------ holds
  defineRoute(app, hooks, { method: 'GET', url: '/v1/holds', summary: 'Held actions you may revoke', tags, query: z.object({ runId: Uuid.optional(), all: z.enum(['true', 'false']).optional() }), handler: ({ control, query }) => control.holds.list.query({ ...(query.runId ? { runId: query.runId } : {}), active: query.all !== 'true' }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/holds/:id', summary: 'A held action and exactly what it will send', tags, params: Id, handler: ({ control, params }) => control.holds.get.query(params) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/holds/:id/revoke', summary: 'Revoke: it never reaches the provider (no confirmation)', tags, params: Id, body: z.object({ reason: z.string().max(500).optional() }).optional(), successStatus: 200, handler: ({ control, params, body }) => control.holds.revoke.mutate({ id: params.id, ...(body?.reason ? { reason: body.reason } : {}) }) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/holds/:id/release', summary: 'Release early (signed in)', tags, params: Id, successStatus: 200, handler: ({ control, params }) => control.holds.release.mutate(params) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/holds/:id/edit-requeue', summary: 'Change the content; it is decided and held again', tags, params: Id, body: z.object({ patch: z.record(z.string(), z.unknown()) }), successStatus: 200, handler: ({ control, params, body }) => control.holds.edit.mutate({ id: params.id, patch: body.patch }) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/holds/revoke',
    summary: 'One-tap revoke from a push notification: a capability for one held action, no session',
    tags,
    auth: false,
    body: z.object({ token: z.string().min(10).max(200) }),
    successStatus: 200,
    handler: async ({ body }) => {
      const control = deps.controlFor({ tenantId: SYSTEM_TENANT, userId: 'system:hold_revoke', system: 'hold_revoke' });
      return control.holds.revokeWithToken.mutate(body);
    },
  });

  // ------------------------------------------------------------ undo
  defineRoute(app, hooks, { method: 'GET', url: '/v1/actions/:id/compensation', summary: 'What undoing it would do: confidence, who is told, how long it stays possible', tags, params: Id, handler: ({ control, params }) => control.undo.compensation.query({ actionId: params.id }) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/actions/:id/compensate', summary: 'Undo a committed action (confirm: true when others will see it)', tags, params: Id, body: z.object({ confirm: z.boolean().optional() }).optional(), successStatus: 202, handler: ({ control, params, body }) => control.undo.compensate.mutate({ actionId: params.id, confirm: body?.confirm ?? false }) });
  // The spec's aliases for the hold operations, addressed by action.
  defineRoute(app, hooks, { method: 'GET', url: '/v1/runs/:id/compensations', summary: 'A run’s compensations, rollbacks and incidents', tags, params: Id, handler: ({ control, params }) => control.undo.forRun.query({ runId: params.id }) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/runs/:id/rollback', summary: 'Undo everything the run did that can still be undone, last first', tags, params: Id, body: z.object({ confirm: z.boolean().optional() }).optional(), successStatus: 202, handler: ({ control, params, body }) => control.undo.rollbackRun.mutate({ runId: params.id, confirm: body?.confirm ?? false }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/rollbacks/:id', summary: 'A rollback and its progress', tags, params: Id, handler: ({ control, params }) => control.undo.rollback.query(params) });

  // ------------------------------------------------------------ metrics, divergences, incidents
  defineRoute(app, hooks, { method: 'GET', url: '/v1/metrics/time-to-undo', summary: 'Time-to-Undo per action type: median, p99, success rate, trend', tags, query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }), handler: ({ control, query }) => control.reversibility.timeToUndo.query({ days: query.days ?? 30 }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/divergences', summary: 'Simulated vs actual effects, and the rate per tool', tags, query: z.object({ toolId: z.string().max(200).optional(), days: z.coerce.number().int().min(1).max(365).optional() }), handler: ({ control, query }) => control.reversibility.divergences.query({ days: query.days ?? 30, ...(query.toolId ? { toolId: query.toolId } : {}) }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/incidents', summary: 'Incidents: failed undos, holds that could not be settled', tags, query: z.object({ state: z.enum(['open', 'acknowledged', 'resolved']).optional() }), handler: ({ control, query }) => control.reversibility.incidents.query(query.state ? { state: query.state } : {}) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/incidents/:id/acknowledge', summary: 'Acknowledge an incident', tags, params: Id, successStatus: 200, handler: ({ control, params }) => control.reversibility.acknowledgeIncident.mutate(params) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/incidents/:id/resolve', summary: 'Resolve an incident, saying how', tags, params: Id, body: z.object({ resolution: z.string().min(3).max(2000) }), successStatus: 200, handler: ({ control, params, body }) => control.reversibility.resolveIncident.mutate({ id: params.id, resolution: body.resolution }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/me/push-topic', summary: 'Your push topic: subscribe on your phone to revoke held actions in one tap', tags, handler: ({ control }) => control.reversibility.pushTopic.query() });
}
