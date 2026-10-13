import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Uuid } from '@vega/contracts';
import { SYSTEM_TENANT } from '@vega/idp';
import type { GatewayDeps } from '../app.js';
import { defineRoute, type RouteHooks } from '../http.js';

/**
 * Approval, Escalation & Action Center — docs/module8.md §7. Deciding needs a signed-in person
 * the control plane authorizes AT DECIDE TIME; rejecting from a push needs only the capability
 * the push carried (the safe action is the fastest); approving from a phone needs the device's
 * biometric (a WebAuthn assertion with user verification).
 */
export function registerApprovalRoutes(app: FastifyInstance, hooks: RouteHooks, deps: GatewayDeps): void {
  const tags = ['approvals'];
  const Id = z.object({ id: Uuid });
  const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
  const Surface = z.enum(['web', 'mobile', 'email']).optional();

  // ------------------------------------------------------------ the queue and the packet
  defineRoute(app, hooks, { method: 'GET', url: '/v1/approvals', summary: 'Your approval queue: urgent first, then soonest to expire', tags, query: z.object({ tier: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(), toolId: z.string().max(200).optional(), agentId: Uuid.optional() }), handler: ({ control, query }) => control.approvals.list.query(query) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/approvals/batches/current', summary: 'Your next review moment', tags, handler: ({ control }) => control.approvals.currentBatch.query() });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/approvals/:id', summary: 'An approval request and its decisions', tags, params: Id, handler: ({ control, params }) => control.approvals.get.query(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/approvals/:id/packet', summary: 'The server-rendered decision packet and its digest (fetching it is recorded)', tags, params: Id, query: z.object({ surface: Surface }), handler: ({ control, params, query }) => control.approvals.packet.mutate({ id: params.id, ...(query.surface ? { surface: query.surface } : {}) }) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/approvals/:id/evidence', summary: 'The evidence was opened (and for how long)', tags, params: Id, body: z.object({ dwellMs: z.number().int().min(0).max(3_600_000).nullable().optional(), surface: Surface }).optional(), successStatus: 200, handler: ({ control, params, body }) => control.approvals.evidence.mutate({ id: params.id, dwellMs: body?.dwellMs ?? null, ...(body?.surface ? { surface: body.surface } : {}) }) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/approvals/:id/decide',
    summary: 'Approve, approve with edits, or reject — on the packet you were shown',
    tags,
    params: Id,
    body: z.object({ decision: z.enum(['approve', 'approve_with_edits', 'reject']), reason: z.string().max(2000).optional(), edits: z.record(z.string(), z.unknown()).optional(), packetDigest: Digest, surface: Surface }),
    successStatus: 200,
    handler: ({ control, params, body }) => control.approvals.decide.mutate({ id: params.id, decision: body.decision, packetDigest: body.packetDigest, ...(body.reason ? { reason: body.reason } : {}), ...(body.edits ? { edits: body.edits } : {}), ...(body.surface ? { surface: body.surface } : {}) }),
  });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/approvals/:id/question', summary: 'Ask without deciding; the expiry pauses once', tags, params: Id, body: z.object({ text: z.string().min(3).max(2000) }), successStatus: 200, handler: ({ control, params, body }) => control.approvals.question.mutate({ id: params.id, text: body.text }) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/approvals/bulk',
    summary: 'Decide a HOMOGENEOUS group at once (same tool, tier and reach); anything else is refused',
    tags,
    body: z.object({ items: z.array(z.object({ id: Uuid, packetDigest: Digest })).min(2).max(50), decision: z.enum(['approve', 'reject']), reason: z.string().max(2000).optional() }),
    successStatus: 200,
    handler: ({ control, body }) => control.approvals.bulk.mutate({ items: body.items, decision: body.decision, ...(body.reason ? { reason: body.reason } : {}) }),
  });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/approvals/reject',
    summary: 'One-tap REJECT from a push notification: a capability for one approval, no session',
    tags,
    auth: false,
    body: z.object({ token: z.string().min(10).max(200) }),
    successStatus: 200,
    handler: async ({ body }) => deps.controlFor({ tenantId: SYSTEM_TENANT, userId: 'system:approval_reject', system: 'approval_reject' }).approvals.rejectWithToken.mutate(body),
  });

  // ------------------------------------------------------------ approving from a phone (biometric)
  defineRoute(app, hooks, { method: 'POST', url: '/v1/me/devices/options', summary: 'Register this phone: WebAuthn creation options (user verification required)', tags, successStatus: 200, handler: ({ control }) => control.approvals.device.registerOptions.mutate() });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/me/devices', summary: 'Register this phone: the attestation', tags, body: z.object({ response: z.record(z.string(), z.unknown()), label: z.string().max(100).optional() }), handler: ({ control, body }) => control.approvals.device.register.mutate({ response: body.response, ...(body.label ? { label: body.label } : {}) }) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/approvals/:id/device-options', summary: 'Approve on this phone: a challenge bound to this approval', tags, params: Id, successStatus: 200, handler: ({ control, params }) => control.approvals.device.approveOptions.mutate(params) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/approvals/:id/approve-on-device',
    summary: 'Approve on this phone: the biometric assertion',
    tags,
    params: Id,
    body: z.object({ response: z.record(z.string(), z.unknown()), packetDigest: Digest, edits: z.record(z.string(), z.unknown()).optional() }),
    successStatus: 200,
    handler: ({ control, params, body }) => control.approvals.device.approve.mutate({ id: params.id, response: body.response, packetDigest: body.packetDigest, ...(body.edits ? { edits: body.edits } : {}) }),
  });

  // ------------------------------------------------------------ delegation
  defineRoute(app, hooks, { method: 'POST', url: '/v1/delegations', summary: 'Delegate your approvals while away (time-bounded, never more than you hold)', tags, body: z.object({ toUser: Uuid, roleScope: z.string().max(40).nullable().optional(), startsAt: z.string().datetime({ offset: true }).optional(), endsAt: z.string().datetime({ offset: true }), reason: z.string().max(500).nullable().optional() }), handler: ({ control, body }) => control.delegations.create.mutate({ toUser: body.toUser, roleScope: body.roleScope ?? null, endsAt: body.endsAt, reason: body.reason ?? null, ...(body.startsAt ? { startsAt: body.startsAt } : {}) }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/delegations', summary: 'Delegations (yours; all for admins and auditors)', tags, handler: ({ control }) => control.delegations.list.query() });
  defineRoute(app, hooks, { method: 'DELETE', url: '/v1/delegations/:id', summary: 'End a delegation now', tags, params: Id, successStatus: 200, handler: ({ control, params }) => control.delegations.revoke.mutate(params) });

  // ------------------------------------------------------------ the Action Center
  const ac = ['action-center'];
  defineRoute(app, hooks, { method: 'GET', url: '/v1/action-center/brief', summary: 'Today: decisions awaiting you, held actions, what needs attention, what ran on its own', tags: ac, handler: ({ control }) => control.actionCenter.brief.query() });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/action-center/tasks', summary: 'Active AI tasks, grouped by state', tags: ac, handler: ({ control }) => control.actionCenter.tasks.query() });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/action-center/security', summary: 'Risk events, blocked actions, approvals, policy and taint violations, failed undos', tags: ac, query: z.object({ agentId: Uuid.optional(), userId: Uuid.optional(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(), days: z.coerce.number().int().min(1).max(90).optional() }), handler: ({ control, query }) => control.actionCenter.security.query({ ...query, days: query.days ?? 14 }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/action-center/usage', summary: 'Runs, models and estimated cost against the budget', tags: ac, query: z.object({ days: z.coerce.number().int().min(1).max(90).optional() }), handler: ({ control, query }) => control.actionCenter.usage.query({ days: query.days ?? 30 }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/action-center/autonomy', summary: 'Per agent: its tier on the ladder, autonomy rate, error rate, Time-to-Undo (the full ladder: /v1/autonomy)', tags: ac, handler: ({ control }) => control.actionCenter.autonomy.query() });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/approval-quality', summary: 'Rubber-stamp monitoring per approver (a product signal, not a performance mark)', tags, query: z.object({ days: z.coerce.number().int().min(1).max(365).optional() }), handler: ({ control, query }) => control.approvalQuality.list.query({ days: query.days ?? 30 }) });
}
