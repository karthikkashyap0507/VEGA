import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { fga, hasCapability } from '@vega/authz';
import { schema } from '@vega/db';
import { Uuid } from '@vega/contracts';
import { toRecord } from '@vega/connector-sdk';
import { autonomyCap, buildTool } from '@vega/connector-mcp';
import { TIERS, type ToolFacts } from '@vega/autonomy';
import { problems } from '@vega/shared';
import { connectorDeps } from '../connectors/common.js';
import { TEAM_TEMPLATES, templateByKey } from '../autonomy/templates.js';
import type { AutonomyService } from '../autonomy/service.js';
import { ProblemError, procedure, requireCapability, requireExposed, requireRelation, router, type AuthedContext, type Context } from '../trpc.js';
import { saveAgentSpec } from './agents.js';

/**
 * Module 10 — earned autonomy, contention control, usage and budgets (docs/module10.md §16).
 *
 * Nothing in this file holds a call back. A tier is enforced by the executor, which reads the
 * state these procedures write; this is where a person asks for evidence, ratifies, demotes,
 * overrides, and reads what the ladder is doing.
 *
 * Exposure (D-09): the certification ladder's SURFACES — running a certification and ratifying
 * a promotion — are plan-gated. Reading the state, demoting, and every contention operation are
 * not: a lower plan still gets the enforcement, and the way to make an agent stricter is never
 * behind a paywall.
 */

function svc(ctx: Context): AutonomyService {
  if (!ctx.deps.autonomy) throw new ProblemError(problems.upstreamUnavailable('autonomy'));
  return ctx.deps.autonomy;
}

const Tier = z.enum(TIERS as unknown as [string, ...string[]]);
const Reason = z.string().trim().min(3).max(500);

/** The declaration facts a certification and a promotion are judged against — read fresh, every time. */
async function toolFacts(ctx: AuthedContext, toolId: string): Promise<ToolFacts> {
  const d = connectorDeps(ctx);
  const builtin = d.registry.get(toolId);
  if (builtin) {
    const r = toRecord(builtin.tool, { skipSchemas: true });
    return { toolId, version: r.version, reversibility: r.reversibility, simulateFidelity: r.simulateFidelity, recipientArgs: r.recipientArgs, autonomyCap: null };
  }
  const row = toolId.startsWith('mcp.') ? await d.mcpStore.get(ctx.principal.tenantId, toolId) : undefined;
  if (!row) throw new ProblemError(problems.notFound('tool not found'));
  const r = toRecord(buildTool(row), { skipSchemas: true });
  return { toolId, version: r.version, reversibility: r.reversibility, simulateFidelity: r.simulateFidelity, recipientArgs: r.recipientArgs, autonomyCap: autonomyCap(row) };
}

async function loadAgent(ctx: AuthedContext, id: string) {
  const [row] = await ctx.db((db) => db.select().from(schema.agents).where(eq(schema.agents.id, id)));
  if (!row) throw new ProblemError(problems.notFound('agent not found'));
  return row;
}

/** Reading the ladder: whoever may read agents; non-managers see agents of workspaces they belong to. */
async function mayRead(ctx: AuthedContext, agentId: string): Promise<void> {
  requireCapability(ctx, 'agents.read');
  const a = await loadAgent(ctx, agentId);
  if (!hasCapability(ctx.principal.role, 'workspaces.manage') && !hasCapability(ctx.principal.role, 'audit.read')) {
    await requireRelation(ctx, 'member', fga.workspace(a.workspaceId));
  }
}

function anyOf(ctx: AuthedContext, ...caps: Parameters<typeof requireCapability>[1][]): void {
  if (caps.some((c) => hasCapability(ctx.principal.role, c))) return;
  throw new ProblemError(problems.forbidden(`role ${ctx.principal.role} lacks ${caps.join(' or ')}`));
}

export const autonomyRouter = router({
  /** GET /v1/autonomy — tiers per workflow × action, with the dashboard's numbers (§15.1). */
  list: procedure.input(z.object({ agentId: Uuid.optional() }).optional()).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    const all = hasCapability(ctx.principal.role, 'workspaces.manage') || hasCapability(ctx.principal.role, 'audit.read');
    if (input?.agentId) await mayRead(ctx, input.agentId);
    const rows = await svc(ctx).overview(ctx.principal.tenantId, input?.agentId ? { agentId: input.agentId } : {});
    if (all || input?.agentId) return { items: rows };
    // A member sees the pairs of the workspaces they belong to, and no others.
    const mine = new Set((await ctx.db((db) => db.select({ id: schema.workspaceMembers.workspaceId }).from(schema.workspaceMembers).where(eq(schema.workspaceMembers.userId, ctx.principal.userId)))).map((r) => r.id));
    const agents = await ctx.db((db) => db.select({ id: schema.agents.id, ws: schema.agents.workspaceId }).from(schema.agents));
    const visible = new Set(agents.filter((a) => mine.has(a.ws)).map((a) => a.id));
    return { items: rows.filter((r) => visible.has(r.workflowKey)) };
  }),

  /** GET /v1/autonomy/:workflow/:action */
  get: procedure.input(z.object({ agentId: Uuid, toolId: z.string().min(3).max(200) })).query(async ({ ctx, input }) => {
    await mayRead(ctx, input.agentId);
    const d = await svc(ctx).detail(ctx.principal.tenantId, input.agentId, input.toolId);
    if (!d) throw new ProblemError(problems.notFound('this action is not on the ladder for this agent'));
    return d;
  }),

  /** Puts a pair on the ladder at SHADOW. Until then the pair is untiered and blocks nothing. */
  enroll: procedure.input(z.object({ agentId: Uuid, toolId: z.string().min(3).max(200) })).mutation(async ({ ctx, input }) => {
    anyOf(ctx, 'agents.manage', 'autonomy.request_promotion');
    await loadAgent(ctx, input.agentId);
    await requireRelation(ctx, 'can_manage', fga.agent(input.agentId));
    await toolFacts(ctx, input.toolId);
    return svc(ctx).enroll(ctx.principal.tenantId, input.agentId, input.toolId);
  }),

  /** POST /v1/autonomy/certify — runs the certification and files a signed report. */
  certify: procedure
    .input(z.object({ agentId: Uuid, toolId: z.string().min(3).max(200), windowDays: z.number().int().min(1).max(365).default(30) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'autonomy.request_promotion');
      requireExposed(ctx, 'certificationLadder');
      await loadAgent(ctx, input.agentId);
      await requireRelation(ctx, 'can_manage', fga.agent(input.agentId));
      const tool = await toolFacts(ctx, input.toolId);
      return svc(ctx).certify({ tenantId: ctx.principal.tenantId, actorId: ctx.principal.userId, agentId: input.agentId, tool, windowDays: input.windowDays });
    }),

  /** GET /v1/certifications/:id */
  certification: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    anyOf(ctx, 'agents.read', 'audit.read');
    const c = await svc(ctx).certification(ctx.principal.tenantId, input.id);
    if (!c) throw new ProblemError(problems.notFound('certification not found'));
    return c;
  }),

  /** GET /v1/certifications/:id/report — the signed artifact (§15.2). */
  report: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    anyOf(ctx, 'agents.read', 'audit.read');
    const r = await svc(ctx).report(ctx.principal.tenantId, input.id);
    if (!r) throw new ProblemError(problems.notFound('certification not found'));
    return r;
  }),

  /** POST /v1/autonomy/promote — human ratification. There is no other way up. */
  promote: procedure
    .input(z.object({ certificationId: Uuid, sampleRate: z.number().int().min(2).max(100).optional() }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'autonomy.ratify');
      requireExposed(ctx, 'certificationLadder');
      const cert = await svc(ctx).certification(ctx.principal.tenantId, input.certificationId);
      if (!cert) throw new ProblemError(problems.notFound('certification not found'));
      const tool = await toolFacts(ctx, cert.actionType);
      return svc(ctx).ratify({ tenantId: ctx.principal.tenantId, actorId: ctx.principal.userId, certificationId: input.certificationId, tool, sampleRate: input.sampleRate });
    }),

  /** POST /v1/autonomy/demote — manual, always allowed to those who may promote, and recorded. */
  demote: procedure.input(z.object({ agentId: Uuid, toolId: z.string().min(3).max(200), to: Tier, reason: Reason })).mutation(async ({ ctx, input }) => {
    anyOf(ctx, 'autonomy.ratify', 'autonomy.request_promotion');
    await loadAgent(ctx, input.agentId);
    if (!hasCapability(ctx.principal.role, 'autonomy.ratify')) await requireRelation(ctx, 'can_manage', fga.agent(input.agentId));
    return svc(ctx).demote({ tenantId: ctx.principal.tenantId, actorId: ctx.principal.userId, agentId: input.agentId, toolId: input.toolId, to: input.to as never, reason: input.reason });
  }),

  /** GET /v1/autonomy/transitions — the full history. */
  transitions: procedure.input(z.object({ agentId: Uuid.optional(), toolId: z.string().max(200).optional() }).optional()).query(async ({ ctx, input }) => {
    if (input?.agentId) await mayRead(ctx, input.agentId);
    else anyOf(ctx, 'workspaces.manage', 'audit.read');
    return { items: await svc(ctx).store.transitions(ctx.principal.tenantId, input?.agentId, input?.toolId) };
  }),

  /** GET /v1/autonomy/proposals */
  proposals: procedure.input(z.object({ state: z.enum(['open', 'accepted', 'dismissed', 'expired']).default('open') }).optional()).query(async ({ ctx, input }) => {
    anyOf(ctx, 'policy.read', 'autonomy.ratify', 'autonomy.request_promotion');
    return { items: await svc(ctx).proposals(ctx.principal.tenantId, input?.state ?? 'open') };
  }),

  /** Mines the override corpus for proposals now (it also runs on a schedule in production). */
  generateProposals: procedure.mutation(async ({ ctx }) => {
    anyOf(ctx, 'policy.manage', 'autonomy.ratify', 'autonomy.request_promotion');
    return { created: await svc(ctx).generateProposals(ctx.principal.tenantId) };
  }),

  /** POST /v1/autonomy/proposals/:id/decide — accepting a proposal changes nothing by itself (§18). */
  decideProposal: procedure.input(z.object({ id: Uuid, decision: z.enum(['accepted', 'dismissed']) })).mutation(async ({ ctx, input }) => {
    anyOf(ctx, 'policy.manage', 'autonomy.ratify', 'autonomy.request_promotion');
    return svc(ctx).decideProposal(ctx.principal.tenantId, input.id, input.decision, ctx.principal.userId);
  }),
});

export const contentionRouter = router({
  /** GET /v1/entities/:key/activity — "who else is on this account" (§10.4). */
  activity: procedure.input(z.object({ entityKey: z.string().trim().min(1).max(300) })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    return svc(ctx).activity(ctx.principal.tenantId, input.entityKey);
  }),

  /** GET /v1/locks */
  locks: procedure.query(async ({ ctx }) => {
    requireCapability(ctx, 'agents.read');
    return { items: await svc(ctx).listLocks(ctx.principal.tenantId) };
  }),

  /** POST /v1/locks/:id/release — admin override: audited, with a reason (§18). */
  releaseLock: procedure.input(z.object({ lockId: Uuid, reason: Reason })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'workspaces.manage');
    return svc(ctx).releaseLock(ctx.principal.tenantId, input.lockId, ctx.principal.userId, input.reason);
  }),

  /** GET /v1/contact-ledger?identity= */
  contactLedger: procedure.input(z.object({ identity: z.string().trim().max(320).optional(), limit: z.number().int().min(1).max(500).default(100) }).optional()).query(async ({ ctx, input }) => {
    anyOf(ctx, 'audit.read', 'agents.manage');
    return { items: await svc(ctx).contactLedger(ctx.principal.tenantId, input?.identity, input?.limit ?? 100) };
  }),

  /** POST /v1/contact-ledger/override — an audited exception for one run, with a reason. */
  contactOverride: procedure
    .input(z.object({ identity: z.string().trim().min(3).max(320), runId: Uuid, reason: Reason, channel: z.enum(['email', 'slack', 'calendar']).default('email') }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'workspaces.manage');
      return svc(ctx).contactOverride({ tenantId: ctx.principal.tenantId, actorId: ctx.principal.userId, identity: input.identity, runId: input.runId, reason: input.reason, channel: input.channel });
    }),

  /** GET /v1/write-conflicts */
  writeConflicts: procedure.input(z.object({ status: z.enum(['open', 'all']).default('all') }).optional()).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.read');
    return { items: await svc(ctx).writeConflicts(ctx.principal.tenantId, input?.status ?? 'all') };
  }),

  /** POST /v1/write-conflicts/:id/resolve — a person picks the winning proposal. */
  resolveConflict: procedure.input(z.object({ id: Uuid, chosenRunId: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.manage');
    return svc(ctx).resolveConflict(ctx.principal.tenantId, input.id, ctx.principal.userId, input.chosenRunId);
  }),
});

const Window = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() });

export const usageRouter = router({
  /** GET /v1/usage — by user, agent, workflow, connector or planning model (§12, §15.5). */
  summary: procedure.input(Window.extend({ by: z.enum(['user', 'agent', 'workflow', 'connector', 'model']).default('agent') })).query(async ({ ctx, input }) => {
    anyOf(ctx, 'audit.read', 'budgets.manage');
    const to = input.to ? new Date(input.to) : new Date();
    const from = input.from ? new Date(input.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw new ProblemError(problems.validation([{ path: 'from', message: 'from must be before to' }]));
    return svc(ctx).usage(ctx.principal.tenantId, { by: input.by, from, to });
  }),

  /** Spend far above its own baseline (§12). Read-only. */
  anomalies: procedure.query(async ({ ctx }) => {
    anyOf(ctx, 'audit.read', 'budgets.manage');
    return { items: await svc(ctx).anomalies(ctx.principal.tenantId) };
  }),

  /** Raises `usage.anomaly` events for new anomalies (once per subject, metric and day). */
  scanAnomalies: procedure.mutation(async ({ ctx }) => {
    requireCapability(ctx, 'budgets.manage');
    return svc(ctx).scanAnomalies(ctx.principal.tenantId);
  }),
});

export const budgetsRouter = router({
  /** GET /v1/budgets */
  get: procedure.query(async ({ ctx }) => {
    anyOf(ctx, 'budgets.manage', 'audit.read');
    return svc(ctx).budget(ctx.principal.tenantId);
  }),

  /** PUT /v1/budgets — the hard cap and what happens at it: degrade, queue or halt. */
  set: procedure
    .input(z.object({ limitCents: z.number().int().min(0).max(100_000_000), breachBehavior: z.enum(['degrade', 'queue', 'halt']) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'budgets.manage');
      return svc(ctx).setBudget(ctx.principal.tenantId, ctx.principal.userId, input);
    }),
});

export const teamTemplatesRouter = router({
  list: procedure.query(({ ctx }) => {
    requireCapability(ctx, 'agents.read');
    return {
      items: TEAM_TEMPLATES.map((t) => ({ key: t.key, name: t.name, summary: t.summary, flow: t.flow, allowedTools: t.spec.allowedTools, policyBindings: t.spec.policyBindings, startsAt: 'SHADOW' as const })),
    };
  }),

  /**
   * Applies a template to an agent the caller manages: saves its spec (a new version, so the
   * ordinary version-change rules apply) and puts every consequential tool of it on the ladder at
   * SHADOW. A template is never a shortcut up the ladder (§11).
   */
  applyTemplate: procedure.input(z.object({ agentId: Uuid, template: z.enum(['sales', 'operations', 'hr', 'marketing', 'management']) })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'agents.manage');
    const tpl = templateByKey(input.template);
    if (!tpl) throw new ProblemError(problems.notFound('template not found'));
    const saved = await saveAgentSpec(ctx, {
      id: input.agentId,
      spec: { ...tpl.spec, triggers: [{ kind: 'manual' }], escalation: { approverRole: 'APPROVER', expiry: '4h', fallback: 'AUTO_REJECT' }, autonomy: 'SHADOW' },
    });
    const enrolled: string[] = [];
    for (const toolId of tpl.spec.allowedTools) {
      let facts: ToolFacts;
      try {
        facts = await toolFacts(ctx, toolId);
      } catch {
        continue; // not available in this tenant: saveAgentSpec would have refused it already
      }
      if (facts.reversibility === 'R0') continue; // reads are not on the ladder
      await svc(ctx).enroll(ctx.principal.tenantId, input.agentId, toolId);
      enrolled.push(toolId);
    }
    return { agent: saved.agent, version: saved.version, template: tpl.key, enrolled, startsAt: 'SHADOW' as const };
  }),
});
