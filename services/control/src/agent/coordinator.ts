import { createHash, createHmac, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, lte } from 'drizzle-orm';
import { Cron } from 'croner';
import { schedRunQueue, schedScheduleAgents, schedWebhookTenants, schema, withTenant } from '@vega/db';
import { AgentSpec, TERMINAL_RUN_STATUSES, type Objective, type RunView } from '@vega/contracts';
import type { ToolRegistry } from '@vega/connector-sdk';
import type { RunTokenIssuer } from '@vega/idp';
import { TransitionError, type LoadedRun, type RunCheckpoint, type RunStore } from '@vega/runs';
import { openSecretAsString, sealSecret, type Logger } from '@vega/shared';
import type { ExecutionClient } from '../connectors/deps.js';
import { understand, type MentionModel } from './intent.js';
import { planRun, type PlanningDeps } from './planning.js';

/**
 * THE COORDINATOR — the control plane's half of the loop (docs/module4.md §3, §8).
 *
 *   CREATED ─C2─▶ PLANNED ─start─▶ (execution) … REPLANNING ─C2─▶ PLANNED ─signal─▶ (execution)
 *
 * Planning stays in the control plane: it holds the model credentials and the planner, and the
 * execution plane cannot call back into it. The executor asks for a replan by moving the run to
 * REPLANNING and waiting on a durable message; this loop sees that, plans the next version and
 * sends it. Every piece of work is claimed first (a status transition or a lease), so any number
 * of control replicas can run this loop, and a crashed one is picked up by the next sweep.
 *
 * It also runs the agent triggers (schedules) and outbound webhook delivery — the other things
 * that happen without a request.
 */

export interface WebhookDeliverer {
  deliver(url: string, body: string, headers: Record<string, string>): Promise<{ status: number }>;
}

export interface AgentCoreDeps {
  store: RunStore;
  execution: ExecutionClient;
  planning: PlanningDeps;
  mentions: MentionModel;
  registry: ToolRegistry;
  log: Logger;
  /** Absent only in loudly-warned development: runs then start without a credential. */
  issuer?: RunTokenIssuer | undefined;
  webhooks?: WebhookDeliverer | undefined;
}

const MAX_WEBHOOK_ATTEMPTS = 10;

// ---------------------------------------------------------------------------- connector bindings
/** Which connector each tool of the spec uses: the principal's own first, then the tenant's. */
export async function bindConnectors(tenantId: string, principalUserId: string, spec: AgentSpec, registry: ToolRegistry): Promise<Record<string, string>> {
  const keys = new Set<string>();
  for (const t of spec.allowedTools) {
    if (t.startsWith('mcp.')) keys.add(t.split('.').slice(0, 2).join('.'));
    else {
      const kind = registry.get(t)?.connector.kind;
      if (kind) keys.add(kind);
    }
  }
  if (!keys.size) return {};
  const rows = await withTenant(tenantId, (db) =>
    db
      .select({ id: schema.connectors.id, kind: schema.connectors.kind, owner: schema.connectors.ownerUserId, config: schema.connectors.config, status: schema.connectors.status })
      .from(schema.connectors)
      .where(inArray(schema.connectors.status, ['active', 'degraded', 'expired']))
      .orderBy(asc(schema.connectors.createdAt)),
  );
  const out: Record<string, string> = {};
  const rank = (r: (typeof rows)[number]) => (r.owner === principalUserId ? 0 : 1) + (r.status === 'active' ? 0 : 2);
  for (const r of [...rows].sort((a, b) => rank(a) - rank(b))) {
    const key = r.kind === 'mcp' ? `mcp.${String((r.config as { slug?: string }).slug ?? '')}` : r.kind;
    if (keys.has(key) && !out[key]) out[key] = r.id;
  }
  return out;
}

// ---------------------------------------------------------------------------- run creation
export class RunRefused extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'PRECONDITION' | 'FORBIDDEN',
    message: string,
  ) {
    super(message);
  }
}

export async function loadAgentSpec(tenantId: string, agentId: string): Promise<{ agent: typeof schema.agents.$inferSelect; spec: AgentSpec; version: number }> {
  const [agent] = await withTenant(tenantId, (db) => db.select().from(schema.agents).where(eq(schema.agents.id, agentId)));
  if (!agent) throw new RunRefused('NOT_FOUND', 'agent not found');
  const [v] = await withTenant(tenantId, (db) =>
    db.select().from(schema.agentVersions).where(and(eq(schema.agentVersions.agentId, agentId), eq(schema.agentVersions.version, agent.version))),
  );
  return { agent, spec: AgentSpec.parse(v?.specJson ?? agent.specJson ?? {}), version: agent.version };
}

/**
 * Creates a run. Origin check first (§5.1 rule 1): `objective` text is accepted only from an
 * authenticated principal (chat, api, test); a schedule or webhook run's objective is the
 * agent's own trigger rule, and any payload it carries is bound as UNTRUSTED input.
 */
export async function createRun(
  core: AgentCoreDeps,
  input: {
    tenantId: string;
    agentId: string;
    principalUserId: string;
    trigger: 'chat' | 'api' | 'test' | 'schedule' | 'webhook';
    objective?: string | undefined;
    conversationId?: string | undefined;
    triggerPayload?: unknown;
  },
): Promise<RunView> {
  const { agent, spec, version } = await loadAgentSpec(input.tenantId, input.agentId);
  if (agent.status !== 'active') throw new RunRefused('PRECONDITION', `agent is ${agent.status}; save a spec in Agent Studio to activate it`);
  const fromPrincipal = input.trigger === 'chat' || input.trigger === 'api' || input.trigger === 'test';
  const text = fromPrincipal ? input.objective : spec.objectiveTemplate;
  if (!text?.trim()) throw new RunRefused('PRECONDITION', fromPrincipal ? 'an objective is required' : 'this agent has no objective template for triggered runs');
  if (!fromPrincipal && input.objective) throw new RunRefused('FORBIDDEN', 'a triggered run cannot carry an objective: content is never an instruction');
  const objective: Objective = await understand(
    { tenantId: input.tenantId, principalUserId: input.principalUserId, text, origin: fromPrincipal ? 'principal' : 'trigger_rule', ...(fromPrincipal ? {} : { trigger: input.trigger }) },
    core.mentions,
  );
  const checkpoint: RunCheckpoint = {
    bindings: await bindConnectors(input.tenantId, input.principalUserId, spec, core.registry),
    approvals: [],
    ...(input.triggerPayload !== undefined ? { triggerPayload: input.triggerPayload } : {}),
  };
  const runId = await core.store.create({
    tenantId: input.tenantId,
    workspaceId: agent.workspaceId,
    agentId: agent.id,
    agentVersion: version,
    principalUserId: input.principalUserId,
    conversationId: input.conversationId ?? null,
    trigger: input.trigger === 'test' ? 'test' : input.trigger,
    objective,
    checkpoint,
  });
  return (await core.store.view(input.tenantId, runId))!;
}

// ---------------------------------------------------------------------------- webhook secrets
export function sealText(s: string): string {
  const e = sealSecret(s);
  return JSON.stringify({ w: e.wrappedDek.toString('base64'), c: e.ciphertext.toString('base64'), i: e.iv.toString('base64'), t: e.authTag.toString('base64'), k: e.kmsKeyId });
}
export function openText(sealed: string): string {
  const j = JSON.parse(sealed) as { w: string; c: string; i: string; t: string; k: string };
  return openSecretAsString({ wrappedDek: Buffer.from(j.w, 'base64'), ciphertext: Buffer.from(j.c, 'base64'), iv: Buffer.from(j.i, 'base64'), authTag: Buffer.from(j.t, 'base64'), kmsKeyId: j.k });
}
export const hashSecret = (s: string) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------------------- the coordinator
export class RunCoordinator {
  private readonly inflight = new Map<string, Promise<void>>();
  private timers: NodeJS.Timeout[] = [];
  private readonly owner = `control-${randomUUID().slice(0, 8)}`;
  /** Tests only: restrict background work to these tenants (suites share one database). */
  onlyTenants: ReadonlySet<string> | undefined;

  constructor(readonly core: AgentCoreDeps) {}

  private mine(tenantId: string): boolean {
    return !this.onlyTenants || this.onlyTenants.has(tenantId);
  }

  /** Process a run now (in the background). Idempotent: a run already being processed is skipped. */
  kick(tenantId: string, runId: string): void {
    if (this.inflight.has(runId)) return;
    const p = this.process(tenantId, runId)
      .catch((err: unknown) => this.core.log.error({ err, run_id: runId }, 'coordinator failed on a run; the next sweep retries'))
      .finally(() => this.inflight.delete(runId));
    this.inflight.set(runId, p);
  }

  /** Waits for whatever is in flight (tests; graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.allSettled([...this.inflight.values()]);
  }

  start(opts: { sweepMs?: number; scheduleMs?: number; webhookMs?: number } = {}): void {
    const every = (ms: number, fn: () => Promise<void>, what: string) => {
      const t = setInterval(() => void fn().catch((err: unknown) => this.core.log.error({ err }, `${what} failed`)), ms);
      t.unref();
      this.timers.push(t);
    };
    every(opts.sweepMs ?? 2_000, () => this.sweep(), 'run sweep');
    every(opts.scheduleMs ?? 30_000, async () => void (await this.scheduleTick(new Date())), 'schedule tick');
    if (this.core.webhooks) every(opts.webhookMs ?? 5_000, () => this.webhookTick(), 'webhook delivery');
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Finds work across tenants through a definer function that returns ids and statuses only. */
  async sweep(): Promise<void> {
    const rows = await schedRunQueue(['CREATED', 'PLANNING', 'PLANNED', 'REPLANNING', 'HELD'], 200);
    const now = Date.now();
    for (const r of rows) {
      if (!this.mine(r.tenantId)) continue;
      const age = now - r.updatedAt.getTime();
      // Fresh PLANNING/PLANNED rows are someone's work in progress; stale ones are orphans.
      if ((r.status === 'PLANNING' || r.status === 'PLANNED') && age < 15_000) continue;
      if (r.status === 'HELD' && age < 1_000) continue;
      this.kick(r.tenantId, r.runId);
    }
  }

  async process(tenantId: string, runId: string): Promise<void> {
    const run = await this.core.store.load(tenantId, runId);
    if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return;
    switch (run.status) {
      case 'CREATED': {
        try {
          await this.core.store.setStatus(tenantId, runId, 'PLANNING', { from: ['CREATED'] });
        } catch (e) {
          if (e instanceof TransitionError) return; // another replica has it
          throw e;
        }
        return this.planNext({ ...run, status: 'PLANNING' });
      }
      case 'PLANNING':
      case 'REPLANNING':
        if (!(await this.core.store.lease(tenantId, runId, [run.status], this.owner, 60_000))) return;
        try {
          return await this.planNext(run);
        } finally {
          await this.core.store.releaseLease(tenantId, runId).catch(() => undefined);
        }
      case 'PLANNED':
        return this.deliver(run, run.programVersion);
      case 'HELD':
        if ((run.pending as { kind?: string } | null)?.kind === 'credential') {
          await this.core.execution.signalRun({ tenantId, runId, topic: 'resume', message: { action: 'resume' }, token: await this.mint(run) });
        }
        return;
      default:
        return;
    }
  }

  /** C2 for the next program version (first plan, clarified plan, or replan). */
  private async planNext(run: LoadedRun): Promise<void> {
    const { store } = this.core;
    const version = run.programVersion + 1;
    const replanning = run.status === 'REPLANNING';
    const pending = (run.pending ?? {}) as { reason?: string; detail?: unknown; fromVersion?: number };
    const committed = replanning || run.checkpoint.started ? (await store.committed(run.tenantId, run.id)).map((c) => ({ toolId: c.toolId, summary: c.summary })) : [];
    const outcome = await planRun(run, this.core.planning, {
      committed,
      ...(replanning && pending.reason ? { feedback: [{ code: pending.reason.toUpperCase(), message: `the previous plan stopped: ${pending.reason}${pending.detail ? ` (${JSON.stringify(pending.detail).slice(0, 300)})` : ''}` }] } : {}),
    });
    const cost = outcome.costCents ? await store.addCost(run.tenantId, run.id, outcome.costCents) : run.costCents;
    if (!outcome.ok) {
      await store.setStatus(run.tenantId, run.id, 'PLAN_REJECTED', { reason: outcome.reason, error: { attempts: outcome.attempts } });
      if (run.checkpoint.started) await this.core.execution.signalRun({ tenantId: run.tenantId, runId: run.id, topic: 'program', message: { abort: outcome.reason } }).catch(() => undefined);
      return;
    }
    if (cost > run.spec.limits.maxCostCents) {
      await store.setStatus(run.tenantId, run.id, 'FAILED', { reason: `max_cost_cents ${run.spec.limits.maxCostCents} exceeded while planning (${cost})` });
      return;
    }
    const programId = await store.saveProgram(run.tenantId, run.id, { version, ast: outcome.program, digest: outcome.digest, modelId: outcome.modelId, source: outcome.source, attempts: outcome.attempts });
    await store.writePlan(run.tenantId, run.id, version, outcome.rows);
    if (replanning && pending.fromVersion) await store.linkReplan(run.tenantId, run.id, pending.fromVersion, programId);

    if (outcome.blocking.length) {
      // §8.2: a HUMAN_INPUT node, the run waits, nothing runs. Never guess for R2/R3.
      const a = outcome.blocking[0]!;
      await store.writePlan(run.tenantId, run.id, version, [{ stepIndex: outcome.rows.length, kind: 'HUMAN_INPUT', dslNodeId: null, toolId: null, status: 'pending' }]);
      await store.updateObjective(run.tenantId, run.id, { ...run.objective, ambiguities: run.objective.ambiguities.map((x) => (outcome.blocking.some((b) => b.binding === x.binding) ? { ...x, blocking: true } : x)) });
      await store.setStatus(run.tenantId, run.id, 'AWAITING_INPUT', {
        reason: `"${a.raw}" could mean ${a.candidates.length} people, and the plan cannot be undone once it runs`,
        pending: { kind: 'clarification', source: 'plan', reason: `Which "${a.raw}"?`, ambiguity: { ...a, blocking: true } },
      });
      return;
    }
    await store.setStatus(run.tenantId, run.id, 'PLANNED', {
      reason: null,
      pending: outcome.assumptions.length ? { kind: 'assumptions', assumptions: outcome.assumptions } : null,
    });
    await this.deliver({ ...run, status: 'PLANNED', programVersion: version }, version);
  }

  /** A planned version goes to the executor: started the first time, signalled after that. */
  private async deliver(run: LoadedRun, version: number): Promise<void> {
    const token = await this.mint(run);
    if (!run.checkpoint.started) {
      await this.core.execution.startRun({ tenantId: run.tenantId, runId: run.id, token });
      await this.core.store.updateCheckpoint(run.tenantId, run.id, (cp) => ({ ...cp, started: true }));
    } else {
      await this.core.execution.signalRun({ tenantId: run.tenantId, runId: run.id, topic: 'program', message: { version }, token });
    }
  }

  /** A run credential: ≤15 minutes, this run only, the agent's tools only (§10). */
  async mint(run: Pick<LoadedRun, 'tenantId' | 'id' | 'agentId' | 'principalUserId' | 'spec'>): Promise<string | undefined> {
    if (!this.core.issuer) return undefined;
    const [agent] = await withTenant(run.tenantId, (db) => db.select({ machine: schema.agents.idpMachineId }).from(schema.agents).where(eq(schema.agents.id, run.agentId)));
    return this.core.issuer.mint({
      agentId: run.agentId,
      onBehalfOfUserId: run.principalUserId,
      tenantId: run.tenantId,
      runId: run.id,
      machineId: agent?.machine ?? `agent:${run.agentId}`,
      scopes: run.spec.allowedTools.map((t) => `tool:${t}`),
    });
  }

  /** After OAuth completes for a connector kind: rebind and resume the runs waiting for it. */
  async connectorAuthorized(tenantId: string, kind: string, connectorId: string): Promise<number> {
    const waiting = await this.core.store.list(tenantId, { status: ['AWAITING_INPUT'], limit: 200 });
    let resumed = 0;
    for (const r of waiting) {
      const p = r.pending as { kind?: string; connector?: string } | null;
      if (p?.kind !== 'reauthorize' || p.connector !== kind) continue;
      await this.core.store.updateCheckpoint(tenantId, r.id, (cp) => ({ ...cp, bindings: { ...cp.bindings, [kind]: connectorId } }));
      const run = await this.core.store.load(tenantId, r.id);
      await this.core.execution.signalRun({ tenantId, runId: r.id, topic: 'resume', message: { action: 'resume' }, token: run ? await this.mint(run) : undefined });
      resumed++;
    }
    return resumed;
  }

  // -------------------------------------------------------------------------- schedule triggers
  /**
   * Fires each schedule at most once per slot, whichever replica sees it first: the slot is a
   * primary key (agent, fire_at). A slot missed by more than 10 minutes (an outage) is skipped.
   */
  async scheduleTick(now: Date): Promise<number> {
    const rows = await schedScheduleAgents();
    let fired = 0;
    for (const a of rows) {
      if (!this.mine(a.tenantId)) continue;
      for (const t of a.triggers ?? []) {
        if (t.kind !== 'schedule' || !t.cron) continue;
        let slot: Date | null;
        try {
          slot = new Cron(t.cron, { timezone: t.tz ?? 'UTC' }).previousRuns(1, now)[0] ?? null;
        } catch {
          continue;
        }
        if (!slot || now.getTime() - slot.getTime() > 10 * 60_000) continue;
        const claimed = await withTenant(a.tenantId, (db) =>
          db.insert(schema.triggerFires).values({ tenantId: a.tenantId, agentId: a.agentId, fireAt: slot! }).onConflictDoNothing().returning({ agentId: schema.triggerFires.agentId }),
        );
        if (!claimed.length) continue;
        try {
          const { agent } = await loadAgentSpec(a.tenantId, a.agentId);
          const run = await createRun(this.core, { tenantId: a.tenantId, agentId: a.agentId, principalUserId: agent.ownerUserId, trigger: 'schedule' });
          await withTenant(a.tenantId, (db) => db.update(schema.triggerFires).set({ runId: run.id }).where(and(eq(schema.triggerFires.agentId, a.agentId), eq(schema.triggerFires.fireAt, slot!))));
          this.kick(a.tenantId, run.id);
          fired++;
        } catch (err) {
          this.core.log.error({ err, agent_id: a.agentId }, 'scheduled run could not be created');
        }
      }
    }
    return fired;
  }

  // -------------------------------------------------------------------------- outbound webhooks
  /**
   * platform_events is the outbox. Each endpoint has a cursor; matching events become deliveries,
   * delivered HMAC-signed (`t=<unix>,v1=<hex>` over "<t>.<body>") with exponential backoff.
   */
  async webhookTick(): Promise<void> {
    const deliverer = this.core.webhooks;
    if (!deliverer) return;
    for (const tenantId of await schedWebhookTenants()) {
      if (!this.mine(tenantId)) continue;
      // One tenant's broken endpoint never holds up another's deliveries.
      await this.webhookTenant(tenantId, deliverer).catch((err: unknown) => this.core.log.error({ err, tenant_id: tenantId }, 'webhook delivery failed for a tenant'));
    }
  }

  private async webhookTenant(tenantId: string, deliverer: WebhookDeliverer): Promise<void> {
    {
      await withTenant(tenantId, async (db) => {
        const endpoints = await db.select().from(schema.webhookEndpoints).where(eq(schema.webhookEndpoints.active, true));
        for (const e of endpoints) {
          const events = await db
            .select({ id: schema.platformEvents.id, kind: schema.platformEvents.kind })
            .from(schema.platformEvents)
            .where(and(gt(schema.platformEvents.id, e.lastEventId), inArray(schema.platformEvents.kind, e.eventKinds)))
            .orderBy(asc(schema.platformEvents.id))
            .limit(200);
          if (events.length) {
            await db.insert(schema.webhookDeliveries).values(events.map((ev) => ({ tenantId, endpointId: e.id, eventId: ev.id, kind: ev.kind }))).onConflictDoNothing();
            await db.update(schema.webhookEndpoints).set({ lastEventId: events.at(-1)!.id }).where(eq(schema.webhookEndpoints.id, e.id));
          }
        }
      });
      const due = await withTenant(tenantId, (db) =>
        db
          .select({ d: schema.webhookDeliveries, url: schema.webhookEndpoints.url, secret: schema.webhookEndpoints.secretSealed })
          .from(schema.webhookDeliveries)
          .innerJoin(schema.webhookEndpoints, eq(schema.webhookEndpoints.id, schema.webhookDeliveries.endpointId))
          .where(and(eq(schema.webhookDeliveries.status, 'pending'), lte(schema.webhookDeliveries.nextAt, new Date())))
          .orderBy(asc(schema.webhookDeliveries.nextAt))
          .limit(20),
      );
      for (const { d, url, secret } of due) {
        const [ev] = await withTenant(tenantId, (db) => db.select().from(schema.platformEvents).where(eq(schema.platformEvents.id, d.eventId)));
        const body = JSON.stringify({ id: d.id, event: d.kind, createdAt: ev?.createdAt.toISOString() ?? null, data: ev?.payload ?? {} });
        const ts = Math.floor(Date.now() / 1000).toString();
        let key: string;
        try {
          key = openText(secret);
        } catch {
          await withTenant(tenantId, (db) => db.update(schema.webhookDeliveries).set({ status: 'failed', lastError: 'the endpoint secret cannot be opened' }).where(eq(schema.webhookDeliveries.id, d.id)));
          continue;
        }
        const sig = createHmac('sha256', key).update(`${ts}.${body}`).digest('hex');
        let status = 0;
        let error: string | null = null;
        try {
          status = (await deliverer.deliver(url, body, { 'content-type': 'application/json', 'x-webhook-event': d.kind, 'x-webhook-delivery': d.id, 'x-webhook-timestamp': ts, 'x-webhook-signature': `t=${ts},v1=${sig}` })).status;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
        }
        const ok = status >= 200 && status < 300;
        const attempts = d.attempts + 1;
        await withTenant(tenantId, (db) =>
          db
            .update(schema.webhookDeliveries)
            .set({
              attempts,
              lastStatus: status || null,
              lastError: ok ? null : (error ?? `HTTP ${status}`),
              status: ok ? 'delivered' : attempts >= MAX_WEBHOOK_ATTEMPTS ? 'failed' : 'pending',
              nextAt: new Date(Date.now() + Math.min(6 * 3_600_000, 30_000 * 2 ** attempts)),
            })
            .where(eq(schema.webhookDeliveries.id, d.id)),
        );
      }
    }
  }
}

/** Most recent runs of a conversation (the chat thread's timeline). */
export async function conversationRuns(tenantId: string, conversationId: string): Promise<Array<{ id: string; status: string }>> {
  return withTenant(tenantId, (db) =>
    db
      .select({ id: schema.runs.id, status: schema.runs.status })
      .from(schema.runs)
      .where(eq(schema.runs.conversationId, conversationId))
      .orderBy(desc(schema.runs.startedAt))
      .limit(100),
  );
}

