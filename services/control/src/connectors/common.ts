import { eq } from 'drizzle-orm';
import { problems, Sealer } from '@vega/shared';
import { schema, type Db } from '@vega/db';
import type { Connector } from '@vega/contracts';
import { DeclarationError, ToolError, type ConnectorDefinition } from '@vega/connector-sdk';
import { ProblemError, type AuthedContext } from '../trpc.js';
import { ExecutionRefused, ExecutionUnavailable, type ConnectorDeps } from './deps.js';

export type OAuthProvider = 'google' | 'microsoft' | 'slack';

/** What travels through the provider's redirect, sealed: the browser can neither read nor alter it. */
export interface OAuthState {
  /** connector id */
  c: string;
  /** tenant id — the callback must arrive in the same tenant */
  t: string;
  /** user id — and from the same user (no cross-user code injection) */
  u: string;
  /** PKCE verifier */
  v: string;
  p: OAuthProvider;
  /** scopes requested */
  s: string[];
}

export const OAUTH_STATE_TTL_SECONDS = 600;

export function connectorDeps(ctx: AuthedContext): ConnectorDeps {
  if (!ctx.deps.connectors) throw new ProblemError(problems.upstreamUnavailable('connectors'));
  return ctx.deps.connectors;
}

export function stateSealer(d: ConnectorDeps): Sealer {
  return new Sealer(d.stateSecret, 'connector-oauth-state');
}

export function definitionFor(d: ConnectorDeps, kind: string): ConnectorDefinition {
  const def = d.registry.connector(kind as ConnectorDefinition['kind']);
  if (!def) throw new ProblemError(problems.validation([{ path: 'kind', message: `unknown connector kind ${kind}` }]));
  return def;
}

export function providerOf(def: ConnectorDefinition): OAuthProvider | null {
  return def.provider === 'google' || def.provider === 'microsoft' || def.provider === 'slack' ? def.provider : null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toConnector(row: typeof schema.connectors.$inferSelect): Connector {
  return {
    id: row.id,
    tenantId: row.tenantId,
    workspaceId: row.workspaceId,
    kind: row.kind as Connector['kind'],
    displayName: row.displayName,
    accountRef: row.accountRef,
    ownerUserId: row.ownerUserId,
    status: row.status as Connector['status'],
    scopesGranted: row.scopesGranted,
    scopesRequired: row.scopesRequired,
    enabledTools: row.enabledTools,
    config: row.config as Record<string, unknown>,
    health: row.healthJson as Record<string, unknown>,
    lastOkAt: iso(row.lastOkAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function loadConnector(ctx: AuthedContext, id: string) {
  const [row] = await ctx.db((db) => db.select().from(schema.connectors).where(eq(schema.connectors.id, id)));
  if (!row) throw new ProblemError(problems.notFound('connector not found'));
  return row;
}

export async function connectorEvent(db: Db, tenantId: string, connectorId: string, kind: string, detail: Record<string, unknown> = {}) {
  await db.insert(schema.connectorEvents).values({ tenantId, connectorId, kind, detail });
}

/** Execution-plane and connector failures → RFC 9457, one mapping. */
export function asProblem(error: unknown): never {
  if (error instanceof ProblemError) throw error;
  if (error instanceof DeclarationError) {
    throw new ProblemError(problems.validation(error.problems.map((message) => ({ path: 'declaration', message }))));
  }
  if (error instanceof ToolError || error instanceof ExecutionRefused) {
    const code = error.code;
    if (code === 'VALIDATION') throw new ProblemError(problems.validation([{ path: '', message: error.message }]));
    if (code === 'EGRESS_DENIED' || code === 'PERMISSION_DENIED') throw new ProblemError(problems.forbidden(error.message));
    if (code === 'NOT_FOUND') throw new ProblemError(problems.notFound(error.message));
    throw new ProblemError(problems.preconditionFailed(error.message));
  }
  if (error instanceof ExecutionUnavailable) throw new ProblemError(problems.upstreamUnavailable('execution plane'));
  throw error;
}

/** http connector: every allowlist entry must be an exact origin — no paths, no wildcards. */
export function checkConfig(kind: string, config: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'http') {
    const list = config['allowlist'];
    if (!Array.isArray(list) || list.length > 50) {
      throw new ProblemError(problems.validation([{ path: 'config.allowlist', message: 'an array of at most 50 origins' }]));
    }
    for (const [i, o] of list.entries()) {
      let origin: string | undefined;
      try {
        origin = typeof o === 'string' ? new URL(o).origin : undefined;
      } catch {
        origin = undefined;
      }
      if (!origin || origin !== o || !/^https?:/.test(origin)) {
        throw new ProblemError(problems.validation([{ path: `config.allowlist.${i}`, message: 'must be an exact origin like https://api.example.com' }]));
      }
    }
    return { allowlist: list };
  }
  if (Object.keys(config).length) {
    throw new ProblemError(problems.validation([{ path: 'config', message: `${kind} connectors take no configuration` }]));
  }
  return {};
}
