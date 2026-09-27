import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Uuid } from '@vega/contracts';
import type { GatewayDeps } from '../app.js';
import { defineRoute, type RouteHooks } from '../http.js';

/**
 * Policy, risk and evaluations — docs/module5.md §7. Authoring is YAML only (raw Rego is refused
 * by the control plane); a bundle is activated only with an attached simulation.
 */
export function registerPolicyRoutes(app: FastifyInstance, hooks: RouteHooks, _deps: GatewayDeps): void {
  const Key = z.object({ key: z.string().min(2).max(64) });
  const Id = z.object({ id: Uuid });
  const Yaml = z.object({ yaml: z.string().min(1).max(20_000) });
  const Weights = z.object({
    w1: z.number(),
    w2: z.number(),
    w3: z.number(),
    w4: z.number(),
    w5: z.number(),
    w6: z.number(),
    w7: z.number(),
    boundaries: z.object({ low: z.number(), medium: z.number(), high: z.number() }),
  });
  const tags = ['policies'];

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/policies',
    summary: 'Policies (latest version of each), the preset mode and the active bundle',
    tags,
    query: z.object({ state: z.enum(['draft', 'simulated', 'active', 'retired']).optional() }),
    handler: ({ control, query }) => control.policies.list.query(query.state ? { state: query.state } : {}),
  });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/policies', summary: 'Create a policy (a draft, v1) from YAML', tags, body: Yaml, successStatus: 201, handler: ({ control, body }) => control.policies.create.mutate(body) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/policies/compile', summary: 'Validate YAML and preview its Rego (nothing is saved)', tags, body: z.object({ yaml: z.string().max(20_000) }), successStatus: 200, handler: ({ control, body }) => control.policies.compile.mutate(body) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/policies/vocabulary', summary: 'Fields, tool ids, presets and packs (editor autocomplete)', tags, handler: ({ control }) => control.policies.vocabulary.query() });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/policies/preset', summary: 'The preset mode (Cautious / Balanced / Fast) and what each does', tags, handler: ({ control }) => control.policies.preset.get.query() });
  defineRoute(app, hooks, {
    method: 'PUT',
    url: '/v1/policies/preset',
    summary: 'Choose the preset mode (every plan)',
    tags,
    body: z.object({ mode: z.enum(['cautious', 'balanced', 'fast']) }),
    handler: ({ control, body }) => control.policies.preset.set.mutate(body),
  });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/policies/packs/:pack',
    summary: 'Adopt a vertical policy pack as drafts',
    tags,
    params: z.object({ pack: z.enum(['professional-services']) }),
    successStatus: 200,
    handler: ({ control, params }) => control.policies.installPack.mutate(params),
  });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/policies/bundles', summary: 'Bundles: candidates, the active one, superseded ones', tags, handler: ({ control }) => control.policies.bundles.query() });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/policies/bundles', summary: 'Compile and sign the working set into a candidate bundle', tags, successStatus: 201, handler: ({ control }) => control.policies.buildBundle.mutate() });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/policies/bundles/:id/activate',
    summary: 'Activate a candidate (requires an attached simulation)',
    tags,
    params: Id,
    successStatus: 200,
    handler: ({ control, params }) => control.policies.activate.mutate({ bundleId: params.id }),
  });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/policies/simulate',
    summary: 'Replay recorded actions (≤ 90 days) against a candidate bundle → change report',
    tags,
    body: z.object({ bundleId: Uuid, windowDays: z.number().int().min(1).max(90).optional() }),
    successStatus: 201,
    handler: ({ control, body }) => control.policies.simulate.mutate({ bundleId: body.bundleId, windowDays: body.windowDays ?? 90 }),
  });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/policies/simulations/:id', summary: 'A simulation report', tags, params: Id, handler: ({ control, params }) => control.policies.simulation.query(params) });
  defineRoute(app, hooks, { method: 'PUT', url: '/v1/policies/:key', summary: 'A new version (a draft); earlier versions are never edited', tags, params: Key, body: Yaml, handler: ({ control, params, body }) => control.policies.update.mutate({ ...params, ...body }) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/policies/:key/retire',
    summary: 'Retire with an effective date (never deleted)',
    tags,
    params: Key,
    body: z.object({ effectiveAt: z.string().datetime().optional() }).optional(),
    successStatus: 200,
    handler: ({ control, params, body }) => control.policies.retire.mutate({ ...params, ...(body?.effectiveAt ? { effectiveAt: body.effectiveAt } : {}) }),
  });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/policies/:key/versions', summary: 'Every version of a policy', tags, params: Key, handler: ({ control, params }) => control.policies.versions.query(params) });
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/policies/:key/diff',
    summary: 'Line diff between two versions (YAML and generated Rego)',
    tags,
    params: Key,
    query: z.object({ from: z.coerce.number().int().min(1), to: z.coerce.number().int().min(1) }),
    handler: ({ control, params, query }) => control.policies.diff.query({ ...params, ...query }),
  });

  // ------------------------------------------------------------------ risk
  const rtags = ['risk'];
  defineRoute(app, hooks, { method: 'GET', url: '/v1/risk/weights', summary: 'The weights in force, their bounds and history', tags: rtags, handler: ({ control }) => control.risk.weights.get.query() });
  defineRoute(app, hooks, { method: 'PUT', url: '/v1/risk/weights', summary: 'New weights (a new version; bounded)', tags: rtags, body: Weights, handler: ({ control, body }) => control.risk.weights.put.mutate(body) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/risk/weights/preview',
    summary: 'Re-score recent actions with candidate weights → the tier shift',
    tags: rtags,
    body: Weights.extend({ days: z.number().int().min(1).max(90).optional() }),
    successStatus: 200,
    handler: ({ control, body }) => control.risk.weights.preview.query({ ...body, days: body.days ?? 30 }),
  });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/risk/score',
    summary: 'Dry-run scoring of a hypothetical action (nothing recorded)',
    tags: rtags,
    body: z.object({ input: z.record(z.string(), z.unknown()) }),
    successStatus: 200,
    handler: ({ control, body }) => control.risk.score.query(body as never),
  });
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/evaluations',
    summary: 'Policy and risk evaluations of a run (the explanation panel)',
    tags: rtags,
    query: z.object({ run_id: Uuid }),
    handler: ({ control, query }) => control.risk.evaluations.query({ runId: query.run_id }),
  });
}
