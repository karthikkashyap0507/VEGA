import { createHash } from 'node:crypto';
import type { ConnectorStatus, Effect, ToolResult } from '@vega/contracts';
import { EffectSchema } from '@vega/contracts';
import { trace } from '@opentelemetry/api';
import type { AnyTool, ConnectorDefinition, ToolContext } from './connector.js';
import { ToolError } from './errors.js';
import { ProviderHttp } from './http.js';
import {
  OAuthError,
  PROVIDERS,
  refreshTokens,
  type ConnectorTokens,
  type OAuthClientConfig,
} from './oauth.js';
import type { BucketSpec, TokenBucket } from './rate-limit.js';
import type { ToolRegistry } from './registry.js';
import { DEFAULT_RETRY, withRetry, type RetryPolicy } from './retry.js';

/**
 * The connector runtime — module2.md §8.2, as Module 4 will call it:
 *
 *   resolve connector, check status → derive idempotency key → short-circuit a prior success
 *   → acquire rate-limit token → refresh auth if needed (single-flight) → execute with timeout
 *   → normalize errors; record invocation; emit span → return Result<Effect>
 *
 * Everything the runtime touches is behind an interface (stores, vault, buckets, OAuth
 * clients), so the same code runs against Postgres + Valkey in the execution plane and against
 * in-memory stores in tests.
 */

export interface ConnectorRecord {
  id: string;
  tenantId: string;
  kind: ConnectorDefinition['kind'];
  status: ConnectorStatus;
  scopesGranted: string[];
  enabledTools: string[];
  config: Record<string, unknown>;
  secretRefId: string | null;
}

export interface ConnectorStore {
  get(tenantId: string, connectorId: string): Promise<ConnectorRecord | undefined>;
  setStatus(tenantId: string, connectorId: string, status: ConnectorStatus, health?: Record<string, unknown>): Promise<void>;
  markOk(tenantId: string, connectorId: string): Promise<void>;
  event(tenantId: string, connectorId: string, kind: string, detail?: Record<string, unknown>): Promise<void>;
  internalDomains(tenantId: string): Promise<string[]>;
}

export interface TokenVault {
  load(tenantId: string, secretRefId: string): Promise<ConnectorTokens>;
  /** Returns the secret_ref id (new when `secretRefId` is undefined). */
  save(tenantId: string, tokens: ConnectorTokens, secretRefId?: string): Promise<string>;
  delete(tenantId: string, secretRefId: string): Promise<void>;
}

export type InvocationClaim =
  | { kind: 'fresh' }
  | { kind: 'replay'; effect: Effect<unknown>; providerRef?: string }
  | { kind: 'in_flight' }
  | { kind: 'mismatch' };

export interface InvocationStore {
  claim(input: {
    tenantId: string;
    connectorId: string;
    toolId: string;
    key: string;
    argsDigest: string;
  }): Promise<InvocationClaim>;
  succeed(tenantId: string, toolId: string, key: string, effect: Effect<unknown>, providerRef?: string): Promise<void>;
  /** A failure that proves nothing happened releases the key; an ambiguous one keeps it. */
  fail(tenantId: string, toolId: string, key: string, code: string, release: boolean): Promise<void>;
}

export interface RuntimeDeps {
  registry: ToolRegistry;
  connectors: ConnectorStore;
  vault: TokenVault;
  invocations: InvocationStore;
  buckets: TokenBucket;
  /** OAuth client credentials per provider; absent → that provider cannot refresh. */
  oauthClients: Partial<Record<'google' | 'microsoft' | 'slack', OAuthClientConfig>>;
  /** Per-kind API base override (sandbox providers, tests). */
  apiBase?: Partial<Record<ConnectorDefinition['kind'], string>>;
  fetchImpl?: typeof fetch;
  retry?: RetryPolicy;
  timeoutMs?: number;
  /** Provider quota, from documentation (certification checklist §12). */
  rateLimits?: Partial<Record<ConnectorDefinition['kind'], BucketSpec>>;
}

export interface InvokeInput {
  tenantId: string;
  connectorId: string;
  toolId: string;
  args: unknown;
  runId?: string;
  nodeId?: string;
}

const DEFAULT_BUCKET: BucketSpec = { capacity: 20, refillPerSecond: 5 };
const REFRESH_SKEW_MS = 60_000;

/** Deterministic key for KEYED tools (module2.md §5.3): run_id + node_id. */
export function idempotencyKeyFor(runId: string, nodeId: string): string {
  return createHash('sha256').update(`${runId}\u0000${nodeId}`).digest('base64url');
}

export function argsDigest(args: unknown): string {
  return createHash('sha256').update(canonical(args)).digest('hex');
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v as object)
    .sort()
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export class ConnectorRuntime {
  /** Single-flight refresh per connector: one refresh in flight, every caller awaits it. */
  private readonly refreshing = new Map<string, Promise<ConnectorTokens>>();
  private readonly tracer = trace.getTracer('connector-runtime');

  constructor(private readonly deps: RuntimeDeps) {}

  private resolve(toolId: string): { tool: AnyTool; def: ConnectorDefinition } {
    const found = this.deps.registry.get(toolId);
    if (!found) throw new ToolError('NOT_FOUND', `unknown tool ${toolId}`, { committed: 'no' });
    return { tool: found.tool, def: found.connector };
  }

  private async loadConnector(input: InvokeInput, tool: AnyTool): Promise<ConnectorRecord> {
    const c = await this.deps.connectors.get(input.tenantId, input.connectorId);
    if (!c) throw new ToolError('NOT_FOUND', 'connector not found', { committed: 'no' });
    if (c.kind !== tool.connectorKind) {
      throw new ToolError('VALIDATION', `${tool.toolId} cannot run on a ${c.kind} connector`, { committed: 'no' });
    }
    if (c.status === 'degraded' || c.status === 'expired') {
      throw new ToolError('AUTH_EXPIRED', 'connector needs re-authorization', { committed: 'no' });
    }
    if (c.status !== 'active') {
      throw new ToolError('CONNECTOR_UNAVAILABLE', `connector is ${c.status}`, { committed: 'no' });
    }
    if (!c.enabledTools.includes(tool.toolId)) {
      throw new ToolError('PERMISSION_DENIED', `${tool.toolId} is not enabled on this connector`, { committed: 'no' });
    }
    const granted = new Set(c.scopesGranted);
    const missing = tool.scopes.filter((s) => !granted.has(s));
    if (missing.length) {
      // Incremental authorization (module2.md §5.5): enabling a tool never silently widens a grant.
      throw new ToolError('PERMISSION_DENIED', `re-consent required for scope(s): ${missing.join(', ')}`, { committed: 'no' });
    }
    return c;
  }

  private async token(c: ConnectorRecord, def: ConnectorDefinition, force = false): Promise<string> {
    if (!c.secretRefId) throw new ToolError('AUTH_EXPIRED', 'connector holds no credential', { committed: 'no' });
    let tokens = await this.deps.vault.load(c.tenantId, c.secretRefId);
    const stale = tokens.expiresAt !== undefined && tokens.expiresAt - REFRESH_SKEW_MS < Date.now();
    if (force || stale) tokens = await this.refreshOnce(c, def, tokens);
    return tokens.accessToken;
  }

  private refreshOnce(c: ConnectorRecord, def: ConnectorDefinition, current: ConnectorTokens): Promise<ConnectorTokens> {
    const inflight = this.refreshing.get(c.id);
    if (inflight) return inflight;
    const p = (async () => {
      const provider = def.provider === 'google' || def.provider === 'microsoft' || def.provider === 'slack' ? def.provider : undefined;
      const client = provider ? this.deps.oauthClients[provider] : undefined;
      if (!provider || !client) {
        throw new ToolError('AUTH_EXPIRED', 'no OAuth client configured to refresh this connector', { committed: 'no' });
      }
      try {
        const next = await refreshTokens(PROVIDERS[provider], client, current);
        await this.deps.vault.save(c.tenantId, next, c.secretRefId ?? undefined);
        await this.deps.connectors.event(c.tenantId, c.id, 'auth_refreshed');
        return next;
      } catch (error) {
        // module2.md §8.3: refresh failure → DEGRADED (not revoked: the user did not revoke it).
        await this.deps.connectors.setStatus(c.tenantId, c.id, 'degraded', { reason: 'refresh_failed' });
        await this.deps.connectors.event(c.tenantId, c.id, 'auth_expired', {
          code: error instanceof OAuthError ? error.code : 'unknown',
        });
        throw new ToolError('AUTH_EXPIRED', 'credential refresh failed; re-authorize the connector', { committed: 'no' });
      }
    })().finally(() => this.refreshing.delete(c.id));
    this.refreshing.set(c.id, p);
    return p;
  }

  private async context(input: InvokeInput, c: ConnectorRecord, def: ConnectorDefinition, idempotencyKey?: string): Promise<ToolContext> {
    const needsAuth = def.provider !== 'none';
    const http = new ProviderHttp({
      baseUrl: this.deps.apiBase?.[def.kind] ?? def.apiBase,
      ...(needsAuth
        ? {
            getToken: () => this.token(c, def),
            onUnauthorized: () => this.token(c, def, true).catch(() => undefined),
          }
        : {}),
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
      timeoutMs: this.deps.timeoutMs ?? 30_000,
    });
    return {
      tenantId: input.tenantId,
      connectorId: c.id,
      http,
      internalDomains: await this.deps.connectors.internalDomains(input.tenantId),
      config: c.config,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    };
  }

  private parseArgs(tool: AnyTool, args: unknown): unknown {
    const parsed = tool.argsSchema.safeParse(args);
    if (!parsed.success) {
      throw new ToolError(
        'VALIDATION',
        parsed.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join('.')}: ${i.message}`).join('; '),
        { committed: 'no' },
      );
    }
    return parsed.data;
  }

  /** Effect-shape check: a tool that returns something its declaration did not promise is a bug. */
  private checkEffect(tool: AnyTool, effect: Effect<unknown>): Effect<unknown> {
    const parsed = EffectSchema(tool.effectSchema).safeParse(effect);
    if (!parsed.success) {
      throw new ToolError('PROVIDER_ERROR', `${tool.toolId} returned an effect outside its declaration`, { committed: 'maybe' });
    }
    return parsed.data as Effect<unknown>;
  }

  /** simulate(): the effect the action WOULD have, computed without side effects (§5.4). */
  async simulate(input: InvokeInput): Promise<ToolResult<unknown>> {
    return this.tracer.startActiveSpan(`simulate ${input.toolId}`, async (span) => {
      span.setAttributes({ tool_id: input.toolId, connector_id: input.connectorId, ...(input.runId ? { run_id: input.runId } : {}) });
      try {
        const { tool, def } = this.resolve(input.toolId);
        const c = await this.loadConnector(input, tool);
        const args = this.parseArgs(tool, input.args);
        await this.deps.buckets.take(`${input.tenantId}:${c.id}`, this.deps.rateLimits?.[def.kind] ?? DEFAULT_BUCKET);
        const ctx = await this.context(input, c, def);
        const effect = await withRetry(() => tool.simulate(args, ctx), 'R0', this.deps.retry ?? DEFAULT_RETRY);
        return { ok: true as const, effect: this.checkEffect(tool, effect) };
      } catch (error) {
        return this.failure(error);
      } finally {
        span.end();
      }
    });
  }

  /**
   * execute(): the side effect. KEYED tools require run/node ids — the key is how "the executor
   * restarted mid-call" becomes one effect rather than two.
   */
  async execute(input: InvokeInput): Promise<ToolResult<unknown>> {
    return this.tracer.startActiveSpan(`execute ${input.toolId}`, async (span) => {
      span.setAttributes({ tool_id: input.toolId, connector_id: input.connectorId, ...(input.runId ? { run_id: input.runId } : {}) });
      let key: string | undefined;
      let tool: AnyTool | undefined;
      try {
        const resolved = this.resolve(input.toolId);
        tool = resolved.tool;
        const def = resolved.def;
        const c = await this.loadConnector(input, tool);
        const args = this.parseArgs(tool, input.args);

        if (tool.idempotency === 'KEYED') {
          if (!input.runId || !input.nodeId) {
            throw new ToolError('VALIDATION', `${tool.toolId} is KEYED: runId and nodeId are required`, { committed: 'no' });
          }
          key = idempotencyKeyFor(input.runId, input.nodeId);
          const claim = await this.deps.invocations.claim({
            tenantId: input.tenantId,
            connectorId: c.id,
            toolId: tool.toolId,
            key,
            argsDigest: argsDigest(args),
          });
          if (claim.kind === 'replay') {
            span.setAttribute('idempotent_replay', true);
            return { ok: true as const, effect: claim.effect, ...(claim.providerRef ? { providerRef: claim.providerRef } : {}) };
          }
          if (claim.kind === 'in_flight') {
            key = undefined; // not ours to finish
            throw new ToolError('CONFLICT', 'an invocation with this key is already in flight', { committed: 'no' });
          }
          if (claim.kind === 'mismatch') {
            key = undefined;
            throw new ToolError('CONFLICT', 'idempotency key reused with different arguments', { committed: 'no' });
          }
        }

        await this.deps.buckets.take(`${input.tenantId}:${c.id}`, this.deps.rateLimits?.[def.kind] ?? DEFAULT_BUCKET);
        const ctx = await this.context(input, c, def, key);
        const out = await withRetry(() => tool!.execute(args, ctx), tool.reversibility, this.deps.retry ?? DEFAULT_RETRY);
        const effect = this.checkEffect(tool, out.effect);
        if (key) await this.deps.invocations.succeed(input.tenantId, tool.toolId, key, effect, out.providerRef);
        await this.deps.connectors.markOk(input.tenantId, c.id);
        return { ok: true as const, effect, ...(out.providerRef ? { providerRef: out.providerRef } : {}) };
      } catch (error) {
        if (key && tool) {
          const release = error instanceof ToolError && error.committed === 'no';
          await this.deps.invocations.fail(input.tenantId, tool.toolId, key, error instanceof ToolError ? error.code : 'PROVIDER_ERROR', release);
        }
        if (error instanceof ToolError && error.code === 'RATE_LIMITED') {
          await this.deps.connectors.event(input.tenantId, input.connectorId, 'rate_limited', { toolId: input.toolId }).catch(() => undefined);
        }
        return this.failure(error);
      } finally {
        span.end();
      }
    });
  }

  private failure(error: unknown): ToolResult<unknown> {
    if (error instanceof ToolError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        },
      };
    }
    return { ok: false, error: { code: 'PROVIDER_ERROR', message: 'unexpected connector failure' } };
  }

  /** Health probe (module2.md §6.4): runs the connector's own probe with its credential. */
  async health(tenantId: string, connectorId: string): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
    const c = await this.deps.connectors.get(tenantId, connectorId);
    if (!c) throw new ToolError('NOT_FOUND', 'connector not found', { committed: 'no' });
    const def = this.deps.registry.connector(c.kind);
    if (!def) throw new ToolError('NOT_FOUND', `no connector implementation for ${c.kind}`, { committed: 'no' });
    const ctx = await this.context({ tenantId, connectorId, toolId: '', args: {} }, c, def);
    try {
      const report = await def.health(ctx);
      if (report.ok) await this.deps.connectors.markOk(tenantId, connectorId);
      await this.deps.connectors.setStatus(tenantId, connectorId, report.ok ? 'active' : c.status, {
        lastProbe: new Date().toISOString(),
        ok: report.ok,
        latencyMs: report.latencyMs,
      });
      return report;
    } catch (error) {
      const code = error instanceof ToolError ? error.code : 'PROVIDER_ERROR';
      await this.deps.connectors.event(tenantId, connectorId, 'error', { code, probe: true });
      return { ok: false, latencyMs: 0, detail: code };
    }
  }
}
