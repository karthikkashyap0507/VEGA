import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { hasCapability } from '@vega/authz';
import { schema } from '@vega/db';
import { Uuid } from '@vega/contracts';
import { problems, type Problem } from '@vega/shared';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { ApprovalRefused, type Actor, type ApprovalService } from '../approvals/service.js';
import { approvalRejectProcedure, procedure, ProblemError, requireCapability, router, type AuthedContext, type Context } from '../trpc.js';

/**
 * Module 8 — the approval API and the Action Center (docs/module8.md §6, §7). The rules live in
 * ApprovalService (decide-time authorization, separation of duties, the packet digest, the corpus
 * row, the receipt); this file maps people and HTTP onto it.
 */

function svc(ctx: Context): ApprovalService {
  if (!ctx.deps.approvals) throw new ProblemError(problems.upstreamUnavailable('approvals'));
  return ctx.deps.approvals;
}

const actor = (ctx: AuthedContext): Actor => ({ tenantId: ctx.principal.tenantId, userId: ctx.principal.userId, role: ctx.principal.role });

const STATUS_PROBLEM: Record<number, Problem['type']> = {
  400: 'https://errors.vega.dev/validation',
  401: 'https://errors.vega.dev/unauthorized',
  403: 'https://errors.vega.dev/forbidden',
  404: 'https://errors.vega.dev/not-found',
  409: 'https://errors.vega.dev/conflict',
  422: 'https://errors.vega.dev/precondition-failed',
  428: 'https://errors.vega.dev/precondition-failed',
  503: 'https://errors.vega.dev/upstream-unavailable',
};

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ApprovalRefused) throw new ProblemError({ type: STATUS_PROBLEM[e.status] ?? 'about:blank', title: e.status === 428 ? 'Precondition required' : 'Refused', status: e.status, detail: e.message });
    throw e;
  }
}

const Surface = z.enum(['web', 'mobile', 'email']).default('web');

export const approvalsRouter = router({
  /** The caller's queue (§6.1): urgent first, then soonest to expire; homogeneous groups marked. */
  list: procedure.input(z.object({ tier: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(), toolId: z.string().max(200).optional(), agentId: Uuid.optional() }).optional()).query(async ({ ctx, input }) => {
    const items = await svc(ctx).queue(actor(ctx), input ?? {});
    const groups = new Map<string, number>();
    for (const i of items) groups.set(i.group, (groups.get(i.group) ?? 0) + 1);
    return { items, groups: [...groups].filter(([, n]) => n > 1).map(([key, count]) => ({ key, count })) };
  }),
  get: procedure.input(z.object({ id: Uuid })).query(({ ctx, input }) => call(() => svc(ctx).get(actor(ctx), input.id))),
  /** The server-rendered packet and its digest. Fetching it is the server's "they looked" (§6.2). */
  packet: procedure.input(z.object({ id: Uuid, surface: Surface.optional() })).mutation(({ ctx, input }) => call(() => svc(ctx).packet(actor(ctx), input.id, input.surface ?? 'web'))),
  evidence: procedure.input(z.object({ id: Uuid, dwellMs: z.number().int().min(0).max(3_600_000).nullable().default(null), surface: Surface.optional() })).mutation(({ ctx, input }) => call(() => svc(ctx).evidenceOpened(actor(ctx), input.id, input.dwellMs, input.surface ?? 'web'))),
  decide: procedure
    .input(
      z.object({
        id: Uuid,
        decision: z.enum(['approve', 'approve_with_edits', 'reject']),
        reason: z.string().max(2000).optional(),
        edits: z.record(z.string(), z.unknown()).optional(),
        packetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        surface: Surface.optional(),
      }),
    )
    .mutation(({ ctx, input }) => call(() => svc(ctx).decide(actor(ctx), input.id, { decision: input.decision, packetDigest: input.packetDigest, surface: input.surface ?? 'web', ...(input.reason ? { reason: input.reason } : {}), ...(input.edits ? { edits: input.edits } : {}) }))),
  question: procedure.input(z.object({ id: Uuid, text: z.string().min(3).max(2000) })).mutation(({ ctx, input }) => call(() => svc(ctx).question(actor(ctx), input.id, input.text))),
  bulk: procedure
    .input(z.object({ items: z.array(z.object({ id: Uuid, packetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/) })).min(2).max(50), decision: z.enum(['approve', 'reject']), reason: z.string().max(2000).optional() }))
    .mutation(({ ctx, input }) => call(() => svc(ctx).bulk(actor(ctx), input.items, input.decision, input.reason))),
  currentBatch: procedure.query(async ({ ctx }) => {
    const b = await svc(ctx).store.currentBatch(ctx.principal.tenantId, ctx.principal.userId);
    return b ? { id: b.id, scheduledAt: b.scheduledAt.toISOString(), items: b.itemCount } : null;
  }),
  /** One-tap reject from a push: a capability for one approval, no session (§6.3). */
  rejectWithToken: approvalRejectProcedure.input(z.object({ token: z.string().min(10).max(200) })).mutation(({ ctx, input }) => call(() => svc(ctx).rejectWithToken(input.token))),

  // ------------------------------------------------------------------ approving from a phone
  device: router({
    registerOptions: procedure.mutation(({ ctx }) => call(() => svc(ctx).deviceRegistrationOptions(actor(ctx)))),
    register: procedure.input(z.object({ response: z.record(z.string(), z.unknown()), label: z.string().max(100).optional() })).mutation(({ ctx, input }) => call(() => svc(ctx).registerDevice(actor(ctx), input.response as unknown as RegistrationResponseJSON, input.label ?? null))),
    approveOptions: procedure.input(z.object({ id: Uuid })).mutation(({ ctx, input }) => call(() => svc(ctx).mobileApproveOptions(actor(ctx), input.id))),
    approve: procedure
      .input(z.object({ id: Uuid, response: z.record(z.string(), z.unknown()), packetDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/), edits: z.record(z.string(), z.unknown()).optional() }))
      .mutation(({ ctx, input }) => call(() => svc(ctx).mobileApprove(actor(ctx), input.id, input.response as unknown as AuthenticationResponseJSON, { packetDigest: input.packetDigest, ...(input.edits ? { edits: input.edits } : {}) }))),
  }),
});

export const delegationsRouter = router({
  create: procedure
    .input(z.object({ toUser: Uuid, roleScope: z.string().max(40).nullable().default(null), startsAt: z.string().datetime({ offset: true }).optional(), endsAt: z.string().datetime({ offset: true }), reason: z.string().max(500).nullable().default(null) }))
    .mutation(({ ctx, input }) => call(() => svc(ctx).delegate(actor(ctx), { toUser: input.toUser, roleScope: input.roleScope, endsAt: new Date(input.endsAt), reason: input.reason, ...(input.startsAt ? { startsAt: new Date(input.startsAt) } : {}) }))),
  list: procedure.query(async ({ ctx }) => {
    const all = hasCapability(ctx.principal.role, 'users.manage') || hasCapability(ctx.principal.role, 'audit.read');
    const rows = await svc(ctx).store.listDelegations(ctx.principal.tenantId, all ? undefined : ctx.principal.userId);
    const now = Date.now();
    return rows.map((d) => ({ id: d.id, fromUser: d.fromUser, toUser: d.toUser, roleScope: d.roleScope, startsAt: d.startsAt.toISOString(), endsAt: d.endsAt.toISOString(), reason: d.reason, active: !d.revokedAt && d.startsAt.getTime() <= now && now < d.endsAt.getTime(), revokedAt: d.revokedAt?.toISOString() ?? null }));
  }),
  revoke: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    const ok = await svc(ctx).store.revokeDelegation(ctx.principal.tenantId, input.id, ctx.principal.userId);
    if (!ok) throw new ProblemError(problems.notFound('no active delegation of yours with that id'));
    return { revoked: true };
  }),
});

/** Rubber-stamp monitoring (§5.6): the compliance view; on self-serve, your own numbers as a nudge. */
export const approvalQualityRouter = router({
  list: procedure.input(z.object({ days: z.number().int().min(1).max(365).default(30) }).optional()).query(async ({ ctx, input }) => {
    const since = new Date(Date.now() - (input?.days ?? 30) * 86_400_000).toISOString().slice(0, 10);
    const rows = await svc(ctx).store.quality(ctx.principal.tenantId, since);
    const all = hasCapability(ctx.principal.role, 'audit.read');
    const names = await ctx.db((db) => db.select({ id: schema.users.id, name: schema.users.displayName, email: schema.users.email }).from(schema.users));
    const nameOf = new Map(names.map((n) => [n.id, n.name ?? n.email]));
    return rows
      .filter((q) => all || q.approverId === ctx.principal.userId)
      .map((q) => ({ approverId: q.approverId, approver: nameOf.get(q.approverId) ?? q.approverId, windowStart: q.windowStart, decisions: q.decisions, medianLatencyMs: q.medianLatencyMs, p10LatencyMs: q.p10LatencyMs, evidenceOpenRate: Number(q.evidenceOpenRate), highEvidenceOpenRate: q.highEvidenceOpenRate === null ? null : Number(q.highEvidenceOpenRate), editRate: Number(q.editRate), rejectRate: Number(q.rejectRate), tooFastRate: Number(q.tooFastRate), flag: q.flag }));
  }),
});

// ============================================================================== the Action Center (§6.4)

const ACTIVE = ['CREATED', 'PLANNING', 'PLANNED', 'EXECUTING', 'REPLANNING', 'COMPENSATING', 'AWAITING_INPUT'] as const;
const GROUPS: Record<string, string> = {
  CREATED: 'RUNNING', PLANNING: 'RUNNING', PLANNED: 'RUNNING', EXECUTING: 'RUNNING', REPLANNING: 'RUNNING', COMPENSATING: 'RUNNING', AWAITING_INPUT: 'NEEDS_ATTENTION',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL', HELD: 'HELD', COMPLETED: 'COMPLETED', FAILED: 'FAILED', PLAN_REJECTED: 'FAILED', CANCELLED: 'FAILED',
  COMPENSATED: 'COMPENSATED', COMPENSATION_FAILED: 'NEEDS_ATTENTION', NEEDS_ATTENTION: 'NEEDS_ATTENTION',
};
const wide = (ctx: AuthedContext) => hasCapability(ctx.principal.role, 'audit.read') || hasCapability(ctx.principal.role, 'workspaces.manage');

export const actionCenterRouter = router({
  /** Today's brief: what needs you, what is held, what went wrong, what ran on its own. */
  brief: procedure.query(async ({ ctx }) => {
    const a = actor(ctx);
    const queue = ctx.deps.approvals ? await ctx.deps.approvals.queue(a) : [];
    const since = new Date(Date.now() - 86_400_000);
    return ctx.db(async (db) => {
      const own = wide(ctx) ? undefined : eq(schema.runs.principalUserId, a.userId);
      const runs = await db.select({ id: schema.runs.id, status: schema.runs.status, objective: schema.runs.objectiveJson, updatedAt: schema.runs.updatedAt, statusReason: schema.runs.statusReason }).from(schema.runs).where(and(gte(schema.runs.updatedAt, since), own));
      const held = await db.select({ id: schema.holds.id, runId: schema.holds.runId, toolId: schema.holds.toolId, expiresAt: schema.holds.expiresAt }).from(schema.holds).where(and(eq(schema.holds.state, 'holding'), sql`${a.userId}::uuid = ANY(${schema.holds.allowedRevokers})`));
      const asked = await db.select({ payload: schema.platformEvents.payload, at: schema.platformEvents.createdAt }).from(schema.platformEvents).where(and(eq(schema.platformEvents.kind, 'approval.question'), gte(schema.platformEvents.createdAt, since), sql`${schema.platformEvents.payload}->>'to' = ${a.userId}`));
      const incidents = wide(ctx) ? await db.select({ id: schema.incidents.id, title: schema.incidents.title, severity: schema.incidents.severity }).from(schema.incidents).where(eq(schema.incidents.state, 'open')) : [];
      const approvedRuns = new Set((await db.select({ runId: schema.approvalRequests.runId }).from(schema.approvalRequests).where(gte(schema.approvalRequests.createdAt, since))).map((r) => r.runId));
      const completed = runs.filter((r) => r.status === 'COMPLETED');
      const objective = (o: unknown) => (o as { objective?: string } | null)?.objective ?? '';
      return {
        generatedAt: new Date().toISOString(),
        decisionsAwaiting: { count: queue.length, urgent: queue.filter((q) => q.urgency === 'urgent').length, soonest: queue[0]?.expiresAt ?? null, items: queue.slice(0, 5).map((q) => ({ id: q.id, title: q.title, riskTier: q.riskTier, expiresAt: q.expiresAt })) },
        held: held.map((h) => ({ ...h, expiresAt: h.expiresAt.toISOString() })),
        needsAttention: runs.filter((r) => ['NEEDS_ATTENTION', 'FAILED', 'COMPENSATION_FAILED', 'AWAITING_INPUT'].includes(r.status)).map((r) => ({ id: r.id, status: r.status, objective: objective(r.objective), reason: r.statusReason })),
        followUps: asked.map((q) => ({ ...(q.payload as Record<string, unknown>), at: q.at.toISOString() })),
        openIncidents: incidents,
        ranAutonomously: completed.filter((r) => !approvedRuns.has(r.id)).length,
        completedToday: completed.length,
        connectorBrief: null as null | { note: string },
      };
    });
  }),

  /** Active AI tasks, grouped by state, with elapsed time, current step, risk, hold remaining. */
  tasks: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'agents.read');
    return ctx.db(async (db) => {
      const own = wide(ctx) ? undefined : eq(schema.runs.principalUserId, ctx.principal.userId);
      const recent = gte(schema.runs.updatedAt, new Date(Date.now() - 7 * 86_400_000));
      const runs = await db.select().from(schema.runs).where(and(own, sql`(${schema.runs.status} IN ('CREATED','PLANNING','PLANNED','EXECUTING','REPLANNING','COMPENSATING','AWAITING_INPUT','AWAITING_APPROVAL','HELD','NEEDS_ATTENTION') OR ${recent})`)).orderBy(desc(schema.runs.updatedAt)).limit(200);
      const ids = runs.map((r) => r.id);
      const nodes = ids.length ? await db.select({ runId: schema.taskNodes.runId, toolId: schema.taskNodes.toolId, status: schema.taskNodes.status, callSeq: schema.taskNodes.callSeq }).from(schema.taskNodes).where(inArray(schema.taskNodes.runId, ids)).orderBy(desc(schema.taskNodes.callSeq)) : [];
      const acts = ids.length ? await db.select({ runId: schema.actions.runId, tier: schema.actions.riskTier }).from(schema.actions).where(inArray(schema.actions.runId, ids)) : [];
      const rank: Record<string, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
      const groups: Record<string, unknown[]> = { RUNNING: [], AWAITING_APPROVAL: [], HELD: [], NEEDS_ATTENTION: [], COMPLETED: [], FAILED: [], COMPENSATED: [] };
      const now = Date.now();
      for (const r of runs) {
        const current = nodes.find((n) => n.runId === r.id);
        const tier = acts.filter((x) => x.runId === r.id && x.tier).sort((a, b) => rank[b.tier!]! - rank[a.tier!]!)[0]?.tier ?? null;
        const pending = r.pendingJson as { releaseAt?: string; expiresAt?: string; toolId?: string } | null;
        groups[GROUPS[r.status] ?? 'RUNNING']!.push({
          id: r.id,
          status: r.status,
          objective: (r.objectiveJson as { objective?: string }).objective ?? '',
          agentId: r.agentId,
          elapsedMs: (r.endedAt ?? new Date(now)).getTime() - r.startedAt.getTime(),
          currentStep: current ? `${current.toolId ?? 'step'} (${current.status})` : null,
          riskTier: tier,
          holdRemainingMs: r.status === 'HELD' && pending?.releaseAt ? Math.max(0, Date.parse(pending.releaseAt) - now) : null,
          approvalExpiresInMs: r.status === 'AWAITING_APPROVAL' && pending?.expiresAt ? Math.max(0, Date.parse(pending.expiresAt) - now) : null,
          reason: r.statusReason,
          updatedAt: r.updatedAt.toISOString(),
        });
      }
      return { groups, active: ACTIVE.length };
    });
  }),

  /** The security center: risk events, blocked actions, approvals, policy and taint violations, failed undos. */
  security: procedure.input(z.object({ agentId: Uuid.optional(), userId: Uuid.optional(), severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(), days: z.number().int().min(1).max(90).default(14) }).optional()).query(async ({ ctx, input }) => {
    if (!wide(ctx)) requireCapability(ctx, 'audit.read');
    const since = new Date(Date.now() - (input?.days ?? 14) * 86_400_000);
    const KINDS: Record<string, { severity: string; title: (p: Record<string, unknown>) => string }> = {
      'policy.denied_action': { severity: 'HIGH', title: (p) => `Blocked by policy: ${p['toolId']} (${p['decidedBy'] ?? 'policy'})` },
      'risk.critical': { severity: 'CRITICAL', title: (p) => `Critical-risk action: ${p['toolId']}` },
      'policy.unavailable': { severity: 'CRITICAL', title: (p) => `Policy engine unavailable — denied ${p['toolId']} (fail closed)` },
      'approval.requested': { severity: 'MEDIUM', title: (p) => `Approval requested: ${p['toolId']} (${p['riskTier'] ?? '—'})` },
      'approval.expired': { severity: 'MEDIUM', title: (p) => `Approval expired: ${p['toolId']} → ${p['fallback']}` },
      'approval.escalated': { severity: 'MEDIUM', title: (p) => `Approval escalated to ${p['to']}: ${p['toolId']}` },
      'approval.rerouted': { severity: 'MEDIUM', title: () => 'Approval re-routed: the assignee no longer had the authority' },
      'approval.quality_flag': { severity: 'HIGH', title: (p) => `Oversight signal: ${p['flag']} — look at the packets and the routing first` },
      'approval.notification_overflow': { severity: 'MEDIUM', title: () => 'Notification budget exceeded: a workflow interrupts too often' },
      'delegation.created': { severity: 'LOW', title: (p) => `Delegation created (${p['roleScope'] ?? 'all approvals'})` },
    };
    return ctx.db(async (db) => {
      const events = await db.select().from(schema.platformEvents).where(and(inArray(schema.platformEvents.kind, Object.keys(KINDS)), gte(schema.platformEvents.createdAt, since))).orderBy(desc(schema.platformEvents.createdAt)).limit(500);
      const taint = await db.select().from(schema.taintViolations).where(gte(schema.taintViolations.createdAt, since)).orderBy(desc(schema.taintViolations.createdAt)).limit(200);
      const incidents = await db.select().from(schema.incidents).where(gte(schema.incidents.createdAt, since)).orderBy(desc(schema.incidents.createdAt)).limit(200);
      const rows = [
        ...events.map((e) => {
          const p = e.payload as Record<string, unknown>;
          const k = KINDS[e.kind]!;
          return { at: e.createdAt.toISOString(), kind: e.kind, severity: k.severity, title: k.title(p), runId: (p['runId'] as string) ?? null, userId: e.actorId ?? (p['by'] as string) ?? (p['approverId'] as string) ?? null, agentId: (p['agentId'] as string) ?? null };
        }),
        ...taint.map((t) => ({ at: t.createdAt.toISOString(), kind: 'taint.violation', severity: t.severity, title: `Taint violation: untrusted content reached ${t.toolId} (${t.kind})`, runId: t.runId, userId: null, agentId: null })),
        ...incidents.map((i) => ({ at: i.createdAt.toISOString(), kind: `incident.${i.kind}`, severity: i.severity, title: i.title, runId: i.runId, userId: null, agentId: null })),
      ];
      return rows
        .filter((r) => (!input?.severity || r.severity === input.severity) && (!input?.userId || r.userId === input.userId) && (!input?.agentId || r.agentId === input.agentId))
        .sort((a, b) => b.at.localeCompare(a.at));
    });
  }),

  /** AI usage: runs, models, estimated cost, against the budget. */
  usage: procedure.input(z.object({ days: z.number().int().min(1).max(90).default(30) }).optional()).query(async ({ ctx, input }) => {
    const since = new Date(Date.now() - (input?.days ?? 30) * 86_400_000);
    return ctx.db(async (db) => {
      const own = wide(ctx) ? undefined : eq(schema.runs.principalUserId, ctx.principal.userId);
      const runs = await db.select({ id: schema.runs.id, agentId: schema.runs.agentId, principal: schema.runs.principalUserId, cost: schema.runs.costCents, status: schema.runs.status, started: schema.runs.startedAt }).from(schema.runs).where(and(gte(schema.runs.startedAt, since), own));
      const programs = runs.length ? await db.select({ runId: schema.programs.runId, modelId: schema.programs.modelId }).from(schema.programs).where(inArray(schema.programs.runId, runs.map((r) => r.id))) : [];
      const [t] = await db.select({ settings: schema.tenants.settings, plan: schema.tenants.plan }).from(schema.tenants).where(eq(schema.tenants.id, ctx.principal.tenantId));
      const [cap] = await db.select({ limitCents: schema.budgets.limitCents }).from(schema.budgets).where(eq(schema.budgets.tenantId, ctx.principal.tenantId));
      const sum = (rs: typeof runs) => rs.reduce((s, r) => s + r.cost, 0);
      const by = <K extends string>(key: (r: (typeof runs)[number]) => K) => {
        const m = new Map<K, typeof runs>();
        for (const r of runs) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
        return [...m].map(([k, rs]) => ({ key: k, runs: rs.length, costCents: sum(rs), completed: rs.filter((r) => r.status === 'COMPLETED').length })).sort((a, b) => b.costCents - a.costCents);
      };
      const models = new Map<string, number>();
      for (const p of programs) models.set(p.modelId, (models.get(p.modelId) ?? 0) + 1);
      const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
      return {
        days: input?.days ?? 30,
        runs: runs.length,
        costCents: sum(runs),
        monthToDateCents: sum(runs.filter((r) => r.started >= monthStart)),
        budgetCents: cap && cap.limitCents > 0 ? cap.limitCents : (((t?.settings ?? {}) as { budgetCents?: number }).budgetCents ?? ctx.entitlements.limits.budgetCents ?? 0),
        byAgent: by((r) => r.agentId),
        byUser: wide(ctx) ? by((r) => r.principal) : [],
        models: [...models].map(([modelId, plans]) => ({ modelId, plans })),
        note: 'Cost is planning plus extraction, as the executor meters it. Per-token counts and routing savings arrive with the model gateway’s metering.',
      };
    });
  }),

  /** The Action Center's autonomy card: per agent, its tier on the ladder (the most restrictive of its enrolled pairs) and the rates. The full ladder is /v1/autonomy. */
  autonomy: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'agents.read');
    const since = new Date(Date.now() - 30 * 86_400_000);
    return ctx.db(async (db) => {
      const agents = await db.select({ id: schema.agents.id, name: schema.agents.name, spec: schema.agents.specJson }).from(schema.agents);
      const runs = await db.select({ id: schema.runs.id, agentId: schema.runs.agentId, status: schema.runs.status }).from(schema.runs).where(gte(schema.runs.startedAt, since));
      const approved = new Set((await db.select({ runId: schema.approvalRequests.runId }).from(schema.approvalRequests).where(gte(schema.approvalRequests.createdAt, since))).map((r) => r.runId));
      const undo = await db.select({ runId: schema.undoMetrics.runId, ms: schema.undoMetrics.durationMs }).from(schema.undoMetrics).where(gte(schema.undoMetrics.requestedAt, since));
      const runAgent = new Map(runs.map((r) => [r.id, r.agentId]));
      const pairs = await db.select({ agent: schema.autonomyState.workflowKey, tool: schema.autonomyState.actionType, tier: schema.autonomyState.tier, since: schema.autonomyState.since }).from(schema.autonomyState);
      const certs = await db.select({ agent: schema.certifications.workflowKey, tool: schema.certifications.actionType, rec: schema.certifications.recommendation, decidedAt: schema.certifications.decidedAt, createdAt: schema.certifications.createdAt, fromTier: schema.certifications.fromTier }).from(schema.certifications).orderBy(desc(schema.certifications.createdAt));
      const order = ['SUSPENDED', 'SHADOW', 'SUPERVISED', 'SAMPLED', 'AUTONOMOUS'];
      return agents.map((a) => {
        const mine = pairs.filter((p) => p.agent === a.id);
        const eligible = mine.filter((p) => {
          const c = certs.find((x) => x.agent === p.agent && x.tool === p.tool);
          return c && c.rec === 'PROMOTE' && !c.decidedAt && c.fromTier === p.tier && c.createdAt >= p.since;
        }).length;
        const rs = runs.filter((r) => r.agentId === a.id);
        const done = rs.filter((r) => r.status === 'COMPLETED');
        const failed = rs.filter((r) => ['FAILED', 'COMPENSATION_FAILED', 'NEEDS_ATTENTION'].includes(r.status));
        const ttu = undo.filter((u) => runAgent.get(u.runId) === a.id && u.ms !== null).map((u) => u.ms!);
        return {
          agentId: a.id,
          name: a.name,
          tier: mine.length ? [...mine].sort((x, y) => order.indexOf(x.tier) - order.indexOf(y.tier))[0]!.tier : ((a.spec as { autonomy?: string }).autonomy ?? 'SHADOW'),
          pairs: mine.length,
          runs: rs.length,
          autonomyRate: rs.length ? done.filter((r) => !approved.has(r.id)).length / rs.length : null,
          errorRate: rs.length ? failed.length / rs.length : null,
          meanTimeToUndoMs: ttu.length ? Math.round(ttu.reduce((s, x) => s + x, 0) / ttu.length) : null,
          promotion: mine.length ? { eligible: eligible > 0, note: eligible > 0 ? `${eligible} action(s) have a passing certification waiting for a person to ratify it.` : 'Promotion is by certification and a person’s ratification; see the autonomy dashboard.' } : { eligible: null, note: 'No action of this agent is on the autonomy ladder yet.' },
        };
      });
    });
  }),
});
