import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import { AgentSpec, Objective, TERMINAL_RUN_STATUSES, type RunStatus, type RunView } from '@vega/contracts';
import { canTransition, TransitionError, webhookKinds } from './transitions.js';

/**
 * The run store — every read and write of runs, programs, the task-node journal, actions and
 * replans, for BOTH planes (control plans and transitions; execution journals). All under
 * withTenant(): a run is tenant data like any other.
 *
 * The journal (task_nodes rows with call_seq) is what makes a durable run replayable and its
 * effects at-most-once: the executor looks a call up by (program version, call_seq) BEFORE
 * doing anything, and a row left `running` by a dead process is the one case it must not
 * guess about (docs/module4.md §8.4).
 */

export interface Grant {
  scopes: string[];
  expiresAt: string;
  jti: string;
}

export interface RunCheckpoint {
  /** Connector kind (or `mcp.<server>`) → connector id, fixed when the run was created. */
  bindings: Record<string, string>;
  /** Approval keys `v<version>:<callSeq>:<argsDigest>`: an approval covers exactly what was shown. */
  approvals: string[];
  /** Hold keys (same shape) whose hold window passed or that someone released early (Module 5). */
  released?: string[] | undefined;
  /** Verified claims of the latest run token (never the token itself). */
  grant?: Grant | undefined;
  answers?: Array<{ field: string; choice: string; by: string; at: string }> | undefined;
  /** A webhook trigger's body: UNTRUSTED content, bound as `trigger_payload`, never the objective. */
  triggerPayload?: unknown;
  /** Set once the durable workflow exists: later plans are SIGNALLED to it, not started. */
  started?: boolean | undefined;
  /** A coordinator's claim on this run while it plans (one planner per run, however many replicas). */
  lease?: { by: string; until: string } | undefined;
}

export interface LoadedRun {
  id: string;
  tenantId: string;
  workspaceId: string;
  agentId: string;
  agentVersion: number;
  principalUserId: string;
  conversationId: string | null;
  trigger: string;
  objective: Objective;
  status: RunStatus;
  statusReason: string | null;
  programVersion: number;
  replanCount: number;
  costCents: number;
  pending: unknown;
  checkpoint: RunCheckpoint;
  spec: AgentSpec;
}

export interface PlanRow {
  stepIndex: number;
  kind: 'TOOL_CALL' | 'HUMAN_INPUT' | 'CHECKPOINT';
  dslNodeId: string | null;
  toolId: string | null;
  plannedReversibility?: string | null;
  plannedEgress?: string | null;
  plannedTaint?: string | null;
  plannedDecision?: string | null;
  plannedRisk?: number | null;
  status?: string;
}

export interface JournalRow {
  id: string;
  programVersion: number;
  stepIndex: number;
  callSeq: number | null;
  dslNodeId: string | null;
  kind: string;
  toolId: string | null;
  argsDigest: string | null;
  status: string;
  attempt: number;
  result: unknown;
  effect: unknown;
  error: unknown;
}

export interface StoredProgram {
  id: string;
  version: number;
  ast: unknown;
  digest: string;
  modelId: string;
  source: string | null;
  attempts: number | null;
  createdAt: Date;
}

const toJournal = (r: typeof schema.taskNodes.$inferSelect): JournalRow => ({
  id: r.id,
  programVersion: r.programVersion,
  stepIndex: r.stepIndex,
  callSeq: r.callSeq,
  dslNodeId: r.dslNodeId,
  kind: r.kind,
  toolId: r.toolId,
  argsDigest: r.argsDigest,
  status: r.status,
  attempt: r.attempt,
  result: r.resultJson,
  effect: r.effectJson,
  error: r.errorJson,
});

const EMPTY_CHECKPOINT: RunCheckpoint = { bindings: {}, approvals: [] };

type Db = Parameters<Parameters<typeof withTenant>[1]>[0];

async function event(db: Db, tenantId: string, kind: string, payload: Record<string, unknown>, actorId: string | null = null) {
  await db.insert(schema.platformEvents).values({ tenantId, actorId, kind, payload });
}

export class RunStore {
  // ------------------------------------------------------------------ runs
  async create(input: {
    tenantId: string;
    workspaceId: string;
    agentId: string;
    agentVersion: number;
    principalUserId: string;
    conversationId?: string | null;
    trigger: 'chat' | 'schedule' | 'webhook' | 'api' | 'test';
    objective: Objective;
    checkpoint: RunCheckpoint;
  }): Promise<string> {
    return withTenant(input.tenantId, async (db) => {
      const [row] = await db
        .insert(schema.runs)
        .values({
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          agentVersion: input.agentVersion,
          principalUserId: input.principalUserId,
          conversationId: input.conversationId ?? null,
          trigger: input.trigger,
          objectiveJson: input.objective,
          checkpointJson: input.checkpoint,
        })
        .returning({ id: schema.runs.id });
      await event(db, input.tenantId, 'run.created', { runId: row!.id, agentId: input.agentId, trigger: input.trigger }, input.principalUserId);
      return row!.id;
    });
  }

  async load(tenantId: string, runId: string): Promise<LoadedRun | null> {
    return withTenant(tenantId, async (db) => {
      const [r] = await db.select().from(schema.runs).where(eq(schema.runs.id, runId));
      if (!r) return null;
      const [v] = await db
        .select({ spec: schema.agentVersions.specJson })
        .from(schema.agentVersions)
        .where(and(eq(schema.agentVersions.agentId, r.agentId), eq(schema.agentVersions.version, r.agentVersion)));
      const [a] = v ? [] : await db.select({ spec: schema.agents.specJson }).from(schema.agents).where(eq(schema.agents.id, r.agentId));
      return {
        id: r.id,
        tenantId: r.tenantId,
        workspaceId: r.workspaceId,
        agentId: r.agentId,
        agentVersion: r.agentVersion,
        principalUserId: r.principalUserId,
        conversationId: r.conversationId,
        trigger: r.trigger,
        objective: Objective.parse(r.objectiveJson),
        status: r.status as RunStatus,
        statusReason: r.statusReason,
        programVersion: r.programVersion,
        replanCount: r.replanCount,
        costCents: r.costCents,
        pending: r.pendingJson,
        checkpoint: { ...EMPTY_CHECKPOINT, ...((r.checkpointJson ?? {}) as Partial<RunCheckpoint>) },
        spec: AgentSpec.parse(v?.spec ?? a?.spec ?? {}),
      };
    });
  }

  /**
   * THE transition. Refuses anything the state machine does not allow; emits `run.status`
   * plus the webhook kinds (§7). Setting the current status again only updates the detail.
   */
  async setStatus(
    tenantId: string,
    runId: string,
    to: RunStatus,
    opts: { reason?: string | null; pending?: unknown; result?: unknown; error?: unknown; actorId?: string | null; from?: readonly RunStatus[] } = {},
  ): Promise<{ from: RunStatus; to: RunStatus }> {
    return withTenant(tenantId, async (db) => {
      const [r] = await db
        .select({ status: schema.runs.status, programVersion: schema.runs.programVersion })
        .from(schema.runs)
        .where(eq(schema.runs.id, runId))
        .for('update');
      if (!r) throw new Error(`run ${runId} not found`);
      const from = r.status as RunStatus;
      if (opts.from && !opts.from.includes(from)) throw new TransitionError(from, to);
      if (!canTransition(from, to)) throw new TransitionError(from, to);
      await db
        .update(schema.runs)
        .set({
          status: to,
          ...(opts.reason !== undefined ? { statusReason: opts.reason } : from !== to ? { statusReason: null } : {}),
          ...(opts.pending !== undefined ? { pendingJson: opts.pending } : from !== to ? { pendingJson: null } : {}),
          ...(opts.result !== undefined ? { resultJson: opts.result } : {}),
          ...(opts.error !== undefined ? { errorJson: opts.error } : {}),
          updatedAt: new Date(),
          ...(TERMINAL_RUN_STATUSES.has(to) ? { endedAt: new Date() } : {}),
        })
        .where(eq(schema.runs.id, runId));
      if (from !== to) {
        const payload = { runId, from, to, reason: opts.reason ?? null, programVersion: r.programVersion };
        await event(db, tenantId, 'run.status', payload, opts.actorId ?? null);
        for (const kind of webhookKinds(from, to, r.programVersion)) await event(db, tenantId, kind, payload, opts.actorId ?? null);
      }
      return { from, to };
    });
  }

  async updateCheckpoint(tenantId: string, runId: string, fn: (cp: RunCheckpoint) => RunCheckpoint): Promise<RunCheckpoint> {
    return withTenant(tenantId, async (db) => {
      const [r] = await db.select({ cp: schema.runs.checkpointJson }).from(schema.runs).where(eq(schema.runs.id, runId)).for('update');
      if (!r) throw new Error(`run ${runId} not found`);
      const next = fn({ ...EMPTY_CHECKPOINT, ...((r.cp ?? {}) as Partial<RunCheckpoint>) });
      await db.update(schema.runs).set({ checkpointJson: next, updatedAt: new Date() }).where(eq(schema.runs.id, runId));
      return next;
    });
  }

  /**
   * Claims the run for `ms` if it is in `status` and nobody holds an unexpired lease. The claim
   * is what keeps two control-plane replicas from planning the same run twice.
   */
  async lease(tenantId: string, runId: string, status: RunStatus[], owner: string, ms: number): Promise<boolean> {
    return withTenant(tenantId, async (db) => {
      const until = new Date(Date.now() + ms).toISOString();
      const rows = await db
        .update(schema.runs)
        .set({ checkpointJson: sql`jsonb_set(coalesce(${schema.runs.checkpointJson}, '{}'::jsonb), '{lease}', ${JSON.stringify({ by: owner, until })}::jsonb)` })
        .where(
          and(
            eq(schema.runs.id, runId),
            inArray(schema.runs.status, status),
            sql`(${schema.runs.checkpointJson}->'lease' IS NULL OR (${schema.runs.checkpointJson}->'lease'->>'until')::timestamptz < now() OR ${schema.runs.checkpointJson}->'lease'->>'by' = ${owner})`,
          ),
        )
        .returning({ id: schema.runs.id });
      return rows.length === 1;
    });
  }

  async releaseLease(tenantId: string, runId: string): Promise<void> {
    await withTenant(tenantId, (db) =>
      db.update(schema.runs).set({ checkpointJson: sql`coalesce(${schema.runs.checkpointJson}, '{}'::jsonb) - 'lease'` }).where(eq(schema.runs.id, runId)),
    );
  }

  async updateObjective(tenantId: string, runId: string, objective: Objective): Promise<void> {
    await withTenant(tenantId, (db) => db.update(schema.runs).set({ objectiveJson: objective, updatedAt: new Date() }).where(eq(schema.runs.id, runId)));
  }

  async addCost(tenantId: string, runId: string, cents: number): Promise<number> {
    if (cents <= 0) return (await this.load(tenantId, runId))?.costCents ?? 0;
    return withTenant(tenantId, async (db) => {
      const [r] = await db
        .update(schema.runs)
        .set({ costCents: sql`${schema.runs.costCents} + ${cents}`, updatedAt: new Date() })
        .where(eq(schema.runs.id, runId))
        .returning({ cost: schema.runs.costCents });
      return r?.cost ?? 0;
    });
  }

  // ------------------------------------------------------------------ programs
  /** Idempotent per (run, version): planning a version twice returns the first. */
  async saveProgram(
    tenantId: string,
    runId: string,
    p: { version: number; ast: unknown; digest: string; modelId: string; source: 'planner' | 'spec' | 'dev_planner'; attempts: number },
  ): Promise<string> {
    return withTenant(tenantId, async (db) => {
      const inserted = await db
        .insert(schema.programs)
        .values({ tenantId, runId, astJson: p.ast, astDigest: p.digest, modelId: p.modelId, valid: true, validationErrors: null, version: p.version, source: p.source, attempts: p.attempts })
        .onConflictDoNothing()
        .returning({ id: schema.programs.id });
      const id =
        inserted[0]?.id ??
        (await db
          .select({ id: schema.programs.id })
          .from(schema.programs)
          .where(and(eq(schema.programs.runId, runId), eq(schema.programs.version, p.version))))[0]!.id;
      await db.update(schema.runs).set({ programId: id, programVersion: p.version, updatedAt: new Date() }).where(eq(schema.runs.id, runId));
      return id;
    });
  }

  async program(tenantId: string, runId: string, version: number): Promise<StoredProgram | null> {
    const [p] = await withTenant(tenantId, (db) =>
      db.select().from(schema.programs).where(and(eq(schema.programs.runId, runId), eq(schema.programs.version, version))),
    );
    return p ? { id: p.id, version: p.version!, ast: p.astJson, digest: p.astDigest, modelId: p.modelId, source: p.source, attempts: p.attempts, createdAt: p.createdAt } : null;
  }

  async programs(tenantId: string, runId: string): Promise<StoredProgram[]> {
    const rows = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.programs)
        .where(and(eq(schema.programs.runId, runId), sql`${schema.programs.version} IS NOT NULL`))
        .orderBy(asc(schema.programs.version)),
    );
    return rows.map((p) => ({ id: p.id, version: p.version!, ast: p.astJson, digest: p.astDigest, modelId: p.modelId, source: p.source, attempts: p.attempts, createdAt: p.createdAt }));
  }

  /** Plan rows, written with pre-annotations BEFORE anything executes (§5.2). */
  async writePlan(tenantId: string, runId: string, version: number, rows: PlanRow[]): Promise<void> {
    if (!rows.length) return;
    await withTenant(tenantId, (db) =>
      db
        .insert(schema.taskNodes)
        .values(
          rows.map((r) => ({
            tenantId,
            runId,
            programVersion: version,
            stepIndex: r.stepIndex,
            kind: r.kind,
            dslNodeId: r.dslNodeId,
            toolId: r.toolId,
            plannedReversibility: r.plannedReversibility ?? null,
            plannedEgress: r.plannedEgress ?? null,
            plannedTaint: r.plannedTaint ?? null,
            plannedDecision: r.plannedDecision ?? null,
            plannedRisk: r.plannedRisk ?? null,
            status: r.status ?? 'pending',
          })),
        )
        .onConflictDoNothing(),
    );
  }

  // ------------------------------------------------------------------ the journal
  async journalCall(tenantId: string, runId: string, version: number, kind: string, callSeq: number): Promise<JournalRow | null> {
    const [r] = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.taskNodes)
        .where(and(eq(schema.taskNodes.runId, runId), eq(schema.taskNodes.programVersion, version), eq(schema.taskNodes.kind, kind), eq(schema.taskNodes.callSeq, callSeq))),
    );
    return r ? toJournal(r) : null;
  }

  /**
   * The Nth invocation of this program version. Returns the existing row if there is one (a
   * replay); otherwise claims the planned row for this call site, or — for a second invocation
   * of the same site (a call inside `map`) or an unplanned call — inserts one.
   */
  async claimCall(
    tenantId: string,
    runId: string,
    c: { version: number; kind?: 'TOOL_CALL' | 'REASONING'; callSeq: number; dslNodeId: string; toolId: string; args: unknown; argsDigest: string },
  ): Promise<{ row: JournalRow; fresh: boolean }> {
    const kind = c.kind ?? 'TOOL_CALL';
    return withTenant(tenantId, async (db) => {
      const byKey = and(eq(schema.taskNodes.runId, runId), eq(schema.taskNodes.programVersion, c.version), eq(schema.taskNodes.kind, kind));
      const [existing] = await db.select().from(schema.taskNodes).where(and(byKey, eq(schema.taskNodes.callSeq, c.callSeq)));
      if (existing) return { row: toJournal(existing), fresh: false };
      const values = { callSeq: c.callSeq, argsJson: c.args, argsDigest: c.argsDigest, toolId: c.toolId, dslNodeId: c.dslNodeId };
      const [plan] = await db
        .select()
        .from(schema.taskNodes)
        .where(and(byKey, eq(schema.taskNodes.dslNodeId, c.dslNodeId), isNull(schema.taskNodes.parentId)))
        .orderBy(asc(schema.taskNodes.stepIndex))
        .limit(1);
      if (plan && plan.callSeq === null) {
        const [claimed] = await db.update(schema.taskNodes).set(values).where(eq(schema.taskNodes.id, plan.id)).returning();
        return { row: toJournal(claimed!), fresh: true };
      }
      const [inserted] = await db
        .insert(schema.taskNodes)
        .values({
          tenantId,
          runId,
          programVersion: c.version,
          kind,
          ...values,
          parentId: plan?.id ?? null,
          // An unplanned call gets a step index past every planned one.
          stepIndex: plan?.stepIndex ?? 10_000 + c.callSeq,
          plannedReversibility: plan?.plannedReversibility ?? null,
          plannedEgress: plan?.plannedEgress ?? null,
          plannedTaint: plan?.plannedTaint ?? null,
          plannedDecision: plan?.plannedDecision ?? null,
        })
        .returning();
      return { row: toJournal(inserted!), fresh: true };
    });
  }

  async markNode(
    tenantId: string,
    runId: string,
    nodeRowId: string,
    patch: { status: string; result?: unknown; effect?: unknown; error?: unknown; start?: boolean; end?: boolean; attempt?: boolean },
  ): Promise<void> {
    await withTenant(tenantId, async (db) => {
      const [row] = await db
        .update(schema.taskNodes)
        .set({
          status: patch.status,
          ...(patch.result !== undefined ? { resultJson: patch.result } : {}),
          ...(patch.effect !== undefined ? { effectJson: patch.effect } : {}),
          ...(patch.error !== undefined ? { errorJson: patch.error } : {}),
          ...(patch.start ? { startedAt: new Date() } : {}),
          ...(patch.end ? { endedAt: new Date() } : {}),
          ...(patch.attempt ? { attempt: sql`${schema.taskNodes.attempt} + 1` } : {}),
        })
        .where(eq(schema.taskNodes.id, nodeRowId))
        .returning({ toolId: schema.taskNodes.toolId, dslNodeId: schema.taskNodes.dslNodeId, callSeq: schema.taskNodes.callSeq, version: schema.taskNodes.programVersion, kind: schema.taskNodes.kind });
      if (row) await event(db, tenantId, 'run.node', { runId, node: nodeRowId, status: patch.status, ...row });
    });
  }

  /** The consequential subset (§4): one action per executed non-read call. */
  async upsertAction(
    tenantId: string,
    a: { runId: string; nodeRowId: string; toolId: string; argsDigest: string; taint: string; reversibility: string; state: 'PLANNED' | 'COMMITTED' | 'FAILED' | 'UNKNOWN' | 'HELD'; effect?: unknown; riskScore?: number | null; riskTier?: string | null },
  ): Promise<void> {
    await withTenant(tenantId, (db) =>
      db
        .insert(schema.actions)
        .values({
          tenantId,
          runId: a.runId,
          nodeId: a.nodeRowId,
          toolId: a.toolId,
          argsDigest: a.argsDigest,
          taintLevel: a.taint,
          reversibility: a.reversibility,
          state: a.state,
          effectJson: a.effect ?? null,
          riskScore: a.riskScore ?? null,
          riskTier: a.riskTier ?? null,
          ...(a.state === 'COMMITTED' ? { committedAt: new Date() } : {}),
        })
        .onConflictDoUpdate({
          target: schema.actions.nodeId,
          set: { state: a.state, ...(a.effect !== undefined ? { effectJson: a.effect } : {}), ...(a.state === 'COMMITTED' ? { committedAt: new Date() } : {}) },
        }),
    );
  }

  /** Planned calls that never ran (a branch not taken, a run that stopped) become `skipped`. */
  async skipPending(tenantId: string, runId: string): Promise<void> {
    await withTenant(tenantId, (db) =>
      db
        .update(schema.taskNodes)
        .set({ status: 'skipped' })
        .where(and(eq(schema.taskNodes.runId, runId), inArray(schema.taskNodes.status, ['pending', 'approving', 'gated']))),
    );
  }

  /** Actions that happened: facts a replan must account for and never redo (§5.5). */
  async committed(tenantId: string, runId: string): Promise<Array<{ toolId: string; argsDigest: string; version: number; summary: string; nodeRowId: string; result: unknown }>> {
    const rows = await withTenant(tenantId, (db) =>
      db
        .select({ toolId: schema.taskNodes.toolId, argsDigest: schema.taskNodes.argsDigest, version: schema.taskNodes.programVersion, effect: schema.taskNodes.effectJson, id: schema.taskNodes.id, result: schema.taskNodes.resultJson, rev: schema.taskNodes.plannedReversibility })
        .from(schema.taskNodes)
        .where(and(eq(schema.taskNodes.runId, runId), eq(schema.taskNodes.kind, 'TOOL_CALL'), eq(schema.taskNodes.status, 'done')))
        .orderBy(asc(schema.taskNodes.programVersion), asc(schema.taskNodes.callSeq)),
    );
    return rows.map((r) => ({
      toolId: r.toolId ?? '',
      argsDigest: r.argsDigest ?? '',
      version: r.version,
      summary: String((r.effect as { summary?: string } | null)?.summary ?? r.toolId ?? '').slice(0, 500),
      nodeRowId: r.id,
      result: r.result,
    }));
  }

  // ------------------------------------------------------------------ replans
  async requestReplan(
    tenantId: string,
    runId: string,
    r: { fromVersion: number; fromStep: number; reason: string; detail: Record<string, unknown> },
  ): Promise<{ replanId: string; count: number }> {
    const out = await withTenant(tenantId, async (db) => {
      const [existing] = await db
        .select({ id: schema.replans.id })
        .from(schema.replans)
        .where(and(eq(schema.replans.runId, runId), eq(schema.replans.fromVersion, r.fromVersion)));
      const [run] = await db.select({ count: schema.runs.replanCount }).from(schema.runs).where(eq(schema.runs.id, runId));
      if (existing) return { replanId: existing.id, count: run?.count ?? 0 };
      const [row] = await db
        .insert(schema.replans)
        .values({ tenantId, runId, fromStep: r.fromStep, fromVersion: r.fromVersion, reason: r.reason, detailJson: r.detail })
        .returning({ id: schema.replans.id });
      const [u] = await db
        .update(schema.runs)
        .set({ replanCount: sql`${schema.runs.replanCount} + 1` })
        .where(eq(schema.runs.id, runId))
        .returning({ count: schema.runs.replanCount });
      return { replanId: row!.id, count: u?.count ?? 1 };
    });
    return out;
  }

  async linkReplan(tenantId: string, runId: string, fromVersion: number, programId: string): Promise<void> {
    await withTenant(tenantId, (db) =>
      db
        .update(schema.replans)
        .set({ newProgramId: programId })
        .where(and(eq(schema.replans.runId, runId), eq(schema.replans.fromVersion, fromVersion))),
    );
  }

  async replans(tenantId: string, runId: string) {
    const rows = await withTenant(tenantId, (db) => db.select().from(schema.replans).where(eq(schema.replans.runId, runId)).orderBy(asc(schema.replans.createdAt)));
    return rows.map((r) => ({ id: r.id, fromVersion: r.fromVersion, fromStep: r.fromStep, reason: r.reason, detail: r.detailJson, newProgramId: r.newProgramId, createdAt: r.createdAt.toISOString() }));
  }

  // ------------------------------------------------------------------ views
  async view(tenantId: string, runId: string): Promise<RunView | null> {
    const [r] = await withTenant(tenantId, (db) => db.select().from(schema.runs).where(eq(schema.runs.id, runId)));
    return r ? toView(r) : null;
  }

  async list(
    tenantId: string,
    f: { status?: RunStatus[] | undefined; agentId?: string | undefined; workspaceId?: string | undefined; principalUserId?: string | undefined; conversationId?: string | undefined; limit?: number | undefined } = {},
  ): Promise<RunView[]> {
    const rows = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.runs)
        .where(
          and(
            f.status?.length ? inArray(schema.runs.status, f.status) : undefined,
            f.agentId ? eq(schema.runs.agentId, f.agentId) : undefined,
            f.workspaceId ? eq(schema.runs.workspaceId, f.workspaceId) : undefined,
            f.principalUserId ? eq(schema.runs.principalUserId, f.principalUserId) : undefined,
            f.conversationId ? eq(schema.runs.conversationId, f.conversationId) : undefined,
          ),
        )
        .orderBy(desc(schema.runs.startedAt))
        .limit(Math.min(f.limit ?? 50, 200)),
    );
    return rows.map(toView);
  }

  async nodes(tenantId: string, runId: string) {
    const rows = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.taskNodes)
        .where(eq(schema.taskNodes.runId, runId))
        .orderBy(asc(schema.taskNodes.programVersion), asc(schema.taskNodes.stepIndex), asc(schema.taskNodes.callSeq)),
    );
    return rows.map((r) => ({
      id: r.id,
      programVersion: r.programVersion,
      stepIndex: r.stepIndex,
      callSeq: r.callSeq,
      parentId: r.parentId,
      dslNodeId: r.dslNodeId,
      kind: r.kind,
      toolId: r.toolId,
      status: r.status,
      attempt: r.attempt,
      args: r.argsJson,
      plannedReversibility: r.plannedReversibility,
      plannedEgress: r.plannedEgress,
      plannedTaint: r.plannedTaint as 'TRUSTED' | 'ORG' | 'UNTRUSTED' | null,
      plannedDecision: r.plannedDecision,
      plannedRisk: r.plannedRisk,
      effect: r.effectJson,
      error: r.errorJson,
      startedAt: r.startedAt?.toISOString() ?? null,
      endedAt: r.endedAt?.toISOString() ?? null,
    }));
  }

  async actions(tenantId: string, runId: string) {
    const rows = await withTenant(tenantId, (db) => db.select().from(schema.actions).where(eq(schema.actions.runId, runId)).orderBy(asc(schema.actions.createdAt)));
    return rows.map((a) => ({ id: a.id, nodeId: a.nodeId, toolId: a.toolId, argsDigest: a.argsDigest, state: a.state, taint: a.taintLevel, reversibility: a.reversibility, riskScore: a.riskScore, riskTier: a.riskTier, effect: a.effectJson, committedAt: a.committedAt?.toISOString() ?? null }));
  }

  /** Progress events for one run after `sinceId` (the SSE stream). */
  async events(tenantId: string, runId: string, sinceId: bigint, limit = 200) {
    const rows = await withTenant(tenantId, (db) =>
      db
        .select()
        .from(schema.platformEvents)
        .where(and(sql`${schema.platformEvents.payload}->>'runId' = ${runId}`, gt(schema.platformEvents.id, sinceId)))
        .orderBy(asc(schema.platformEvents.id))
        .limit(limit),
    );
    return rows.map((e) => ({ id: e.id.toString(), kind: e.kind, payload: e.payload, at: e.createdAt.toISOString() }));
  }

  /** Runs in these statuses, across tenants the caller names (the coordinator's work queue). */
  async inStatus(tenantId: string, statuses: RunStatus[], limit = 50): Promise<Array<{ id: string; status: RunStatus; pending: unknown; updatedAt: Date }>> {
    const rows = await withTenant(tenantId, (db) =>
      db
        .select({ id: schema.runs.id, status: schema.runs.status, pending: schema.runs.pendingJson, updatedAt: schema.runs.updatedAt })
        .from(schema.runs)
        .where(inArray(schema.runs.status, statuses))
        .orderBy(asc(schema.runs.updatedAt))
        .limit(limit),
    );
    return rows.map((r) => ({ ...r, status: r.status as RunStatus }));
  }
}

function toView(r: typeof schema.runs.$inferSelect): RunView {
  return {
    id: r.id,
    tenantId: r.tenantId,
    workspaceId: r.workspaceId,
    agentId: r.agentId,
    agentVersion: r.agentVersion,
    principalUserId: r.principalUserId,
    conversationId: r.conversationId,
    trigger: r.trigger,
    objective: r.objectiveJson as Objective,
    status: r.status as RunStatus,
    statusReason: r.statusReason,
    programVersion: r.programVersion,
    replanCount: r.replanCount,
    pending: r.pendingJson ?? null,
    result: r.resultJson ?? null,
    error: r.errorJson ?? null,
    costCents: r.costCents,
    startedAt: r.startedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
  };
}
