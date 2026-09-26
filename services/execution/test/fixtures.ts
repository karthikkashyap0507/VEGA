import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { ConnectorRuntime, MemoryTokenBucket, PgConnectorStore, PgInvocationStore, PgTokenVault } from '@vega/connector-sdk';
import { McpToolSource, PgMcpToolStore } from '@vega/connector-mcp';
import { launchRegistry } from '@vega/connectors';
import type { AgentSpec, Objective } from '@vega/contracts';
import { parse } from '@vega/dsl';
import { RunTokenIssuer, RunTokenVerifier } from '@vega/idp';
import { PgEntities, PgRecorder, programDigest, SchemaRegistry, type ExtractorPort } from '@vega/interpreter';
import { type HOOK_ORDER, type Hooks, type PolicyDecision, type StepContext } from '@vega/orchestration';
import { RunStore } from '@vega/runs';
import { RuntimeDeclarations } from '../src/programs.js';
import { executionHooks, type ExecutorDeps, type ExecutorLog, type ToolInvoker } from '../src/executor/index.js';
import { devModel, Extractor } from '../../extractor/src/extract.js';

/**
 * Shared set-up for the executor suites: a seeded tenant with Gmail + Calendar connected to
 * the provider fakes, the real connector runtime over Postgres (ledger included), and the
 * executor's dependencies with a recording hook chain.
 */

process.env['DATABASE_URL'] ??= 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
process.env['DATABASE_APP_URL'] ??= 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';
// Connector tokens are sealed; a per-process test key (child workers inherit it).
process.env['LOCAL_KEK_BASE64'] ??= randomBytes(32).toString('base64');
export const OWNER_URL = process.env['DATABASE_URL'];
export const ISSUER = 'https://control.test';
export const AUDIENCE = 'execution';

export function dbosUrl(name: string): string {
  const u = new URL(OWNER_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

export const silent: ExecutorLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

export interface Tenant {
  tenantId: string;
  userId: string;
  workspaceId: string;
  agentId: string;
  email: string;
  domain: string;
}

export async function seedTenant(): Promise<Tenant> {
  const pool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
  const slug = `exec-${randomBytes(4).toString('hex')}`;
  const domain = `${slug}.example`;
  try {
    const t = await pool.query<{ id: string }>(`INSERT INTO tenants (name, slug, plan, retention_days) VALUES ($1, $2, 'business', 400) RETURNING id`, [slug, slug]);
    const tenantId = t.rows[0]!.id;
    const u = await pool.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, 'Owner', 'OWNER', 'active') RETURNING id`, [tenantId, `owner@${domain}`]);
    const ws = await pool.query<{ id: string }>(`INSERT INTO workspaces (tenant_id, name, slug) VALUES ($1, 'Ops', 'ops') RETURNING id`, [tenantId]);
    const ag = await pool.query<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1, $2, 'assistant', $3, 'machine-test', 'active') RETURNING id`, [
      tenantId,
      ws.rows[0]!.id,
      u.rows[0]!.id,
    ]);
    return { tenantId, userId: u.rows[0]!.id, workspaceId: ws.rows[0]!.id, agentId: ag.rows[0]!.id, email: `owner@${domain}`, domain };
  } finally {
    await pool.end();
  }
}

export async function setAgentSpec(t: Tenant, version: number, spec: Partial<AgentSpec>): Promise<void> {
  const pool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    await pool.query(`INSERT INTO agent_versions (tenant_id, agent_id, version, spec_json, created_by) VALUES ($1, $2, $3, $4, $5)`, [t.tenantId, t.agentId, version, JSON.stringify(spec), t.userId]);
    await pool.query(`UPDATE agents SET spec_json = $1, version = $2 WHERE id = $3`, [JSON.stringify(spec), version, t.agentId]);
  } finally {
    await pool.end();
  }
}

export async function ownerQuery<T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const pool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
  try {
    return (await pool.query<T>(sql, params)).rows;
  } finally {
    await pool.end();
  }
}

/** A connector authorized against the fakes (token issued directly: this suite is not about OAuth). */
export async function connect(t: Tenant, kind: 'gmail' | 'gcal', grant: (scopes: string[]) => { access: string; refresh: string }): Promise<string> {
  const registry = launchRegistry();
  const tools = registry.toolsFor(kind);
  const scopes = [...new Set(tools.flatMap((x) => x.scopes))];
  const tok = grant(scopes);
  const secret = await new PgTokenVault().save(t.tenantId, { accessToken: tok.access, refreshToken: tok.refresh, expiresAt: Date.now() + 3_600_000, scopesGranted: scopes });
  const rows = await ownerQuery<{ id: string }>(
    `INSERT INTO connectors (tenant_id, kind, display_name, account_ref, owner_user_id, scopes_granted, scopes_required, enabled_tools, secret_ref_id, status)
     VALUES ($1, $2, $2, $3, $4, $5, $5, $6, $7, 'active') RETURNING id`,
    [t.tenantId, kind, t.email, t.userId, scopes, tools.map((x) => x.toolId), secret],
  );
  return rows[0]!.id;
}

export function runtimeFor(fetchImpl: typeof fetch): ConnectorRuntime {
  const registry = launchRegistry();
  return new ConnectorRuntime({
    registry,
    dynamicTools: new McpToolSource(new PgMcpToolStore()),
    connectors: new PgConnectorStore(),
    vault: new PgTokenVault(),
    invocations: new PgInvocationStore(),
    buckets: new MemoryTokenBucket(),
    oauthClients: { google: { clientId: 'g', clientSecret: 's', redirectUri: 'https://api.test/v1/oauth/google/callback', fetchImpl } },
    fetchImpl,
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
  });
}

/** Every hook invocation, in order, per (run, callSeq) — what the ordering test asserts. */
export class HookRecorder {
  readonly log: Array<{ runId: string; callSeq: number; toolId: string; step: (typeof HOOK_ORDER)[number] }> = [];
  wrap(inner: Hooks): Hooks {
    const rec = (ctx: { runId: string; callSeq: number; toolId: string }, step: (typeof HOOK_ORDER)[number]) => this.log.push({ runId: ctx.runId, callSeq: ctx.callSeq, toolId: ctx.toolId, step });
    return {
      policy: async (c) => (rec(c, 'policy'), inner.policy(c)),
      simulate: async (c) => (rec(c, 'simulate'), inner.simulate(c)),
      approval: async (c, s, p, a) => (rec(c, 'approval'), inner.approval(c, s, p, a)),
      receipt: async (c, r) => (rec(c, r.phase === 'pre' ? 'receipt:pre' : 'receipt:post'), inner.receipt(c, r)),
      captureCompensator: async (c, s) => (rec(c, 'captureCompensator'), inner.captureCompensator(c, s)),
      verify: async (c, r) => (rec(c, 'verify'), inner.verify(c, r)),
    };
  }
  steps(runId: string, callSeq: number): string[] {
    return this.log.filter((l) => l.runId === runId && l.callSeq === callSeq).map((l) => l.step);
  }
  markCall(runId: string, callSeq: number, toolId: string) {
    this.log.push({ runId, callSeq, toolId, step: 'call' });
  }
}

/** The quarantined extractor's dev model, in process (the isolation itself is M3's suite). */
export function devExtractor(): ExtractorPort {
  const ex = new Extractor(devModel(), 'dev');
  return { extract: async (i) => (await ex.extract(i.schema, i.content, i.purpose)).data };
}

export interface ExecutorKit {
  deps: ExecutorDeps;
  store: RunStore;
  runtime: ConnectorRuntime;
  issuer: RunTokenIssuer;
  verifier: RunTokenVerifier;
  hookLog: HookRecorder;
  /** Called with (runId, callSeq) as the provider call is made, after every pre-call hook. */
  onExecute?: ((i: { runId: string; nodeId: string; toolId: string }) => Promise<void> | void) | undefined;
}

/**
 * A TEST DOUBLE for the policy hook, named for what it is. The Module 4 suites exercise the
 * executor (journal, hook order, crash windows), not policy; the real engine is exercised by
 * test/policy.test.ts and the cross-plane suites. Production has no permissive policy at all.
 */
export const allowAllPolicyForExecutorTests = async (): Promise<PolicyDecision> => ({ decision: 'ALLOW', reason: 'test double: executor suite, not the policy engine' });

export async function executorKit(
  fetchImpl: typeof fetch,
  opts: { extractor?: ExtractorPort; hooks?: (h: Hooks) => Hooks; policy?: (ctx: StepContext) => Promise<PolicyDecision> } = {},
): Promise<ExecutorKit> {
  const runtime = runtimeFor(fetchImpl);
  const registry = launchRegistry();
  const store = new RunStore();
  const issuer = await RunTokenIssuer.ephemeral(ISSUER, AUDIENCE);
  const verifier = new RunTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: issuer.jwks });
  const hookLog = new HookRecorder();
  const kit = { store, runtime, issuer, verifier, hookLog } as ExecutorKit;
  const invoker: ToolInvoker = {
    execute: async (i) => {
      hookLog.markCall(i.runId, Number(i.nodeId.split('.')[1]), i.toolId);
      await kit.onExecute?.({ runId: i.runId, nodeId: i.nodeId, toolId: i.toolId });
      return runtime.execute(i);
    },
    simulate: (i) => runtime.simulate(i),
  };
  const base = executionHooks({ log: silent, invoker, requireEvidence: false, policy: opts.policy ?? allowAllPolicyForExecutorTests });
  kit.deps = {
    store,
    invoker,
    declarations: new RuntimeDeclarations(registry, runtime),
    extractor: opts.extractor ?? devExtractor(),
    entities: new PgEntities(),
    hooks: hookLog.wrap(opts.hooks ? opts.hooks(base) : base),
    schemas: new SchemaRegistry(),
    recorder: () => new PgRecorder(),
    log: silent,
    requireGrant: true,
  };
  return kit;
}

export function objectiveFor(t: Tenant, text: string, extra: Partial<Objective> = {}): Objective {
  return { objective: text, entities: [], constraints: [], successCriteria: [], ambiguities: [], requestedAutonomy: 'supervised', origin: { kind: 'principal', principalUserId: t.userId }, ...extra };
}

/** What the control plane does before execution: create, plan (v1), grant a token. */
export async function plannedRun(
  kit: ExecutorKit,
  t: Tenant,
  program: string,
  opts: { bindings: Record<string, string>; objective?: Objective; agentVersion?: number; scopes?: string[]; ttl?: number; triggerPayload?: unknown },
): Promise<{ runId: string; token: string }> {
  const runId = await kit.store.create({
    tenantId: t.tenantId,
    workspaceId: t.workspaceId,
    agentId: t.agentId,
    agentVersion: opts.agentVersion ?? 1,
    principalUserId: t.userId,
    trigger: 'api',
    objective: opts.objective ?? objectiveFor(t, 'test objective'),
    checkpoint: { bindings: opts.bindings, approvals: [], ...(opts.triggerPayload !== undefined ? { triggerPayload: opts.triggerPayload } : {}) },
  });
  await kit.store.setStatus(t.tenantId, runId, 'PLANNING');
  await savePlan(kit, t, runId, 1, program);
  await kit.store.setStatus(t.tenantId, runId, 'PLANNED');
  const token = await kit.issuer.mint(
    { agentId: t.agentId, onBehalfOfUserId: t.userId, tenantId: t.tenantId, runId, machineId: 'machine-test', scopes: opts.scopes ?? launchRegistry().records().map((r) => `tool:${r.toolId}`) },
    opts.ttl ?? 900,
  );
  const v = await kit.verifier.verify(token);
  await kit.store.updateCheckpoint(t.tenantId, runId, (cp) => ({ ...cp, grant: { scopes: v.scopes, expiresAt: v.expiresAt.toISOString(), jti: v.jti } }));
  return { runId, token };
}

export async function savePlan(kit: ExecutorKit, t: Tenant, runId: string, version: number, program: string): Promise<void> {
  const ast = parse(program);
  await kit.store.saveProgram(t.tenantId, runId, { version, ast, digest: programDigest(ast), modelId: 'test', source: 'spec', attempts: 1 });
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 20_000, what = 'condition'): Promise<T> {
  const started = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
