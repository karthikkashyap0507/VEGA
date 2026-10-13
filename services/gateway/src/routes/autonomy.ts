import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Uuid } from '@vega/contracts';
import { defineRoute, type RouteHooks } from '../http.js';

/**
 * Earned autonomy, contention control, usage and budgets — docs/module10.md §16.
 *
 * Nothing here holds a call back: a tier is enforced by the executor, which reads the state these
 * routes write. The routes are where a person asks for evidence, ratifies, demotes, overrides and
 * reads. Promotion is only ever `POST /v1/autonomy/promote` — a named human on a certification.
 */
export function registerAutonomyRoutes(app: FastifyInstance, hooks: RouteHooks): void {
  const Id = z.object({ id: Uuid });
  const ToolId = z.string().min(3).max(200);
  const Tier = z.enum(['SHADOW', 'SUPERVISED', 'SAMPLED', 'AUTONOMOUS', 'SUSPENDED']);
  const Reason = z.string().trim().min(3).max(500);

  // ------------------------------------------------------------ the ladder
  let tags = ['autonomy'];
  defineRoute(app, hooks, { method: 'GET', url: '/v1/autonomy', summary: 'Tiers per workflow × action: autonomy rate, errors, days at tier, the gate checklist', tags, query: z.object({ agentId: Uuid.optional() }), handler: ({ control, query }) => control.autonomy.list.query(query) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/autonomy/transitions', summary: 'Every promotion and demotion, with who and why', tags, query: z.object({ agentId: Uuid.optional(), toolId: ToolId.optional() }), handler: ({ control, query }) => control.autonomy.transitions.query(query) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/autonomy/proposals', summary: 'Learned-policy proposals, each citing the decisions behind it', tags, query: z.object({ state: z.enum(['open', 'accepted', 'dismissed', 'expired']).optional() }), handler: ({ control, query }) => control.autonomy.proposals.query(query) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/autonomy/proposals/generate', summary: 'Mine the override corpus for proposals now', tags, successStatus: 200, handler: ({ control }) => control.autonomy.generateProposals.mutate() });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/autonomy/proposals/:id/decide',
    summary: 'Accept or dismiss a proposal (accepting changes nothing by itself: the change is made as a normal, audited one)',
    tags,
    params: Id,
    body: z.object({ decision: z.enum(['accepted', 'dismissed']) }),
    successStatus: 200,
    handler: ({ control, params, body }) => control.autonomy.decideProposal.mutate({ id: params.id, decision: body.decision }),
  });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/autonomy/:workflow/:action', summary: 'One pair: tier, transitions, certifications, open proposals', tags, params: z.object({ workflow: Uuid, action: ToolId }), handler: ({ control, params }) => control.autonomy.get.query({ agentId: params.workflow, toolId: params.action }) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/autonomy/enroll',
    summary: 'Put a workflow × action on the ladder at SHADOW (until then it is untiered and blocks nothing)',
    tags,
    body: z.object({ agentId: Uuid, toolId: ToolId }),
    successStatus: 200,
    handler: ({ control, body }) => control.autonomy.enroll.mutate(body),
  });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/autonomy/certify',
    summary: 'Run a certification over the override corpus; the report is signed into the evidence chain',
    tags,
    body: z.object({ agentId: Uuid, toolId: ToolId, windowDays: z.number().int().min(1).max(365).optional() }),
    handler: ({ control, body }) => control.autonomy.certify.mutate({ ...body, windowDays: body.windowDays ?? 30 }),
  });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/autonomy/promote',
    summary: 'Ratify a certification: a named human, one rung, gate re-checked now (there is no other way up)',
    tags,
    body: z.object({ certificationId: Uuid, sampleRate: z.number().int().min(2).max(100).optional() }),
    successStatus: 200,
    handler: ({ control, body }) => control.autonomy.promote.mutate(body),
  });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/autonomy/demote',
    summary: 'Demote by hand: always allowed, stricter only, with a reason',
    tags,
    body: z.object({ agentId: Uuid, toolId: ToolId, to: Tier, reason: Reason }),
    successStatus: 200,
    handler: ({ control, body }) => control.autonomy.demote.mutate(body),
  });

  tags = ['certifications'];
  defineRoute(app, hooks, { method: 'GET', url: '/v1/certifications/:id', summary: 'A certification: scores, gate, recommendation, ratification', tags, params: Id, handler: ({ control, params }) => control.autonomy.certification.query(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/certifications/:id/report', summary: 'The report as signed and filed: taxonomy, pinned versions, the chain entry that holds it', tags, params: Id, handler: ({ control, params }) => control.autonomy.report.query(params) });

  // ------------------------------------------------------------ contention
  tags = ['contention'];
  defineRoute(app, hooks, { method: 'GET', url: '/v1/entities/:key/activity', summary: 'Who else is on this account: every agent acting on it, with intent and lock state', tags, params: z.object({ key: z.string().trim().min(1).max(300) }), handler: ({ control, params }) => control.contention.activity.query({ entityKey: params.key }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/locks', summary: 'Active entity locks', tags, handler: ({ control }) => control.contention.locks.query() });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/locks/:id/release', summary: 'Admin override: release a lock (audited; a reason is required)', tags, params: Id, body: z.object({ reason: Reason }), successStatus: 200, handler: ({ control, params, body }) => control.contention.releaseLock.mutate({ lockId: params.id, reason: body.reason }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/contact-ledger', summary: 'Who was contacted, by which agent, and until when they are in cooldown', tags, query: z.object({ identity: z.string().trim().max(320).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }), handler: ({ control, query }) => control.contention.contactLedger.query(query) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/contact-ledger/override',
    summary: 'An audited exception: let one run contact a person inside their cooldown (a reason is required)',
    tags,
    body: z.object({ identity: z.string().trim().min(3).max(320), runId: Uuid, reason: Reason, channel: z.enum(['email', 'slack', 'calendar']).optional() }),
    handler: ({ control, body }) => control.contention.contactOverride.mutate({ ...body, channel: body.channel ?? 'email' }),
  });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/write-conflicts', summary: 'Concurrent writes that disagreed, and how each was settled', tags, query: z.object({ status: z.enum(['open', 'all']).optional() }), handler: ({ control, query }) => control.contention.writeConflicts.query(query) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/write-conflicts/:id/resolve', summary: 'Choose the winning write of an escalated conflict', tags, params: Id, body: z.object({ chosenRunId: Uuid }), successStatus: 200, handler: ({ control, params, body }) => control.contention.resolveConflict.mutate({ id: params.id, chosenRunId: body.chosenRunId }) });

  // ------------------------------------------------------------ usage & budgets (P5)
  tags = ['usage'];
  defineRoute(app, hooks, { method: 'GET', url: '/v1/usage', summary: 'Usage and cost by user, agent, workflow, connector or model', tags, query: z.object({ by: z.enum(['user', 'agent', 'workflow', 'connector', 'model']).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional() }), handler: ({ control, query }) => control.usage.summary.query({ ...query, by: query.by ?? 'agent' }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/usage/anomalies', summary: 'Spend or volume far above its own baseline', tags, handler: ({ control }) => control.usage.anomalies.query() });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/usage/anomalies/scan', summary: 'Raise usage.anomaly events for new anomalies (once per subject, metric and day)', tags, successStatus: 200, handler: ({ control }) => control.usage.scanAnomalies.mutate() });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/budgets', summary: 'The hard cap, what happens at it, and the month so far', tags, handler: ({ control }) => control.budgets.get.query() });
  defineRoute(app, hooks, { method: 'PUT', url: '/v1/budgets', summary: 'Set the cap and the breach behavior: degrade, queue or halt', tags, body: z.object({ limitCents: z.number().int().min(0).max(100_000_000), breachBehavior: z.enum(['degrade', 'queue', 'halt']) }), handler: ({ control, body }) => control.budgets.set.mutate(body) });

  // ------------------------------------------------------------ team templates (P2)
  tags = ['templates'];
  defineRoute(app, hooks, { method: 'GET', url: '/v1/team-templates', summary: 'Sales, Operations, HR, Marketing, Management — every one starts at SHADOW', tags, handler: ({ control }) => control.teamTemplates.list.query() });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/agents/:id/apply-template',
    summary: 'Apply a team template to an agent: saves its spec as a new version and enrolls its consequential tools at SHADOW',
    tags,
    params: Id,
    body: z.object({ template: z.enum(['sales', 'operations', 'hr', 'marketing', 'management']) }),
    successStatus: 200,
    handler: ({ control, params, body }) => control.teamTemplates.applyTemplate.mutate({ agentId: params.id, template: body.template }),
  });
}
