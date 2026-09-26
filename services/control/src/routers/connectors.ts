import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { problems } from '@vega/shared';
import { schema } from '@vega/db';
import { ConnectorKind, CreateConnector, PageQuery, UpdateConnector, Uuid } from '@vega/contracts';
import {
  authorizeUrl,
  consentModel,
  exchangeCode,
  minimalScopes,
  OAuthError,
  pkcePair,
  PROVIDERS,
  revokeTokens,
  toRecord,
} from '@vega/connector-sdk';
import { ProblemError, procedure, requireCapability, router, type AuthedContext } from '../trpc.js';
import { afterCursor, decodeCursor, emitEvent, isUniqueViolation, newestFirst, page } from '../lib.js';
import {
  asProblem,
  checkConfig,
  connectorDeps,
  connectorEvent,
  definitionFor,
  loadConnector,
  OAUTH_STATE_TTL_SECONDS,
  providerOf,
  stateSealer,
  toConnector,
  type OAuthProvider,
  type OAuthState,
} from '../connectors/common.js';

/**
 * Connectors — docs/module2.md §7, §8.1, §8.3.
 *
 * Authorization round-trip:
 *   create/reauthorize → minimal scope union from declarations → sealed state (tenant, user,
 *   PKCE verifier) → provider consent → completeOAuth: open state, require SAME tenant and SAME
 *   user, exchange code → seal tokens into secret_refs → active → health probe (execution plane)
 *
 * Revocation: provider revoke endpoint FIRST, then delete our copy of the secret — both, in
 * that order, and the connector is unusable from the moment this procedure starts.
 */

function scopesFor(ctx: AuthedContext, kind: string, enabled: string[]): string[] {
  const def = definitionFor(connectorDeps(ctx), kind);
  const known = new Set(def.tools.map((t) => t.toolId));
  const unknown = enabled.filter((t) => !known.has(t));
  if (unknown.length) {
    throw new ProblemError(problems.validation([{ path: 'enabledTools', message: `not tools of ${kind}: ${unknown.join(', ')}` }]));
  }
  try {
    return minimalScopes(def.tools, enabled);
  } catch (error) {
    throw new ProblemError(problems.validation([{ path: 'enabledTools', message: (error as Error).message }]));
  }
}

async function mcpToolIds(ctx: AuthedContext, connectorId: string): Promise<Set<string>> {
  const rows = await connectorDeps(ctx).mcpStore.list(ctx.principal.tenantId, connectorId);
  return new Set(rows.map((r) => r.toolId));
}

/** Builds the provider consent URL; the verifier leaves this process only sealed inside `state`. */
function consentUrl(ctx: AuthedContext, row: { id: string; kind: string; accountRef: string | null }, scopes: string[]): string {
  const d = connectorDeps(ctx);
  const def = definitionFor(d, row.kind);
  const provider = providerOf(def);
  if (!provider) throw new ProblemError(problems.preconditionFailed(`${row.kind} connectors do not use OAuth`));
  const client = d.oauthClients[provider];
  if (!client) throw new ProblemError(problems.preconditionFailed(`no OAuth client is configured for ${provider}`));
  const { verifier, challenge } = pkcePair();
  const state: OAuthState = { c: row.id, t: ctx.principal.tenantId, u: ctx.principal.userId, v: verifier, p: provider, s: scopes };
  return authorizeUrl(PROVIDERS[provider], client, {
    scopes,
    state: stateSealer(d).seal(state, OAUTH_STATE_TTL_SECONDS),
    codeChallenge: challenge,
    ...(row.accountRef ? { loginHint: row.accountRef } : {}),
  });
}

/** Probe via the execution plane and record the provider account. Never fails the caller. */
async function probe(ctx: AuthedContext, connectorId: string) {
  const d = connectorDeps(ctx);
  try {
    const report = await d.execution.health(ctx.principal.tenantId, connectorId);
    if (report.accountRef) {
      try {
        await ctx.db((db) => db.update(schema.connectors).set({ accountRef: report.accountRef! }).where(eq(schema.connectors.id, connectorId)));
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return { ...report, duplicateAccount: true };
      }
    }
    return { ...report, duplicateAccount: false };
  } catch (error) {
    ctx.log.warn({ err: error, connectorId }, 'connector health probe failed');
    return { ok: false, latencyMs: 0, detail: 'probe unavailable', duplicateAccount: false };
  }
}

/** Revoke at the provider, then delete our copy. Returns whether the provider confirmed. */
async function revokeCredential(ctx: AuthedContext, row: typeof schema.connectors.$inferSelect): Promise<boolean> {
  const d = connectorDeps(ctx);
  if (!row.secretRefId) return false;
  const def = definitionFor(d, row.kind);
  const provider = providerOf(def);
  const client = provider ? d.oauthClients[provider] : undefined;
  let confirmed = false;
  const tokens = await d.vault.load(ctx.principal.tenantId, row.secretRefId).catch(() => undefined);
  if (provider && client && tokens) {
    try {
      await revokeTokens(PROVIDERS[provider], client, tokens);
      confirmed = true;
    } catch (error) {
      ctx.log.warn({ err: error, connectorId: row.id }, 'provider revocation failed; deleting our copy regardless');
    }
  }
  await ctx.db(async (db) => {
    await db.update(schema.connectors).set({ secretRefId: null }).where(eq(schema.connectors.id, row.id));
    await connectorEvent(db, ctx.principal.tenantId, row.id, confirmed ? 'provider_revoked' : 'provider_revoke_unconfirmed');
  });
  await d.vault.delete(ctx.principal.tenantId, row.secretRefId);
  return confirmed;
}

export const connectorsRouter = router({
  /** Every connector kind this deployment can offer, with its declarations (the gallery). */
  catalog: procedure.query(({ ctx }) => {
    requireCapability(ctx, 'connectors.read');
    const d = connectorDeps(ctx);
    return d.registry.allConnectors().map((def) => {
      const provider = providerOf(def);
      return {
        kind: def.kind,
        displayName: def.displayName,
        provider: def.provider,
        available: provider ? Boolean(d.oauthClients[provider]) : true,
        tools: def.tools.map((t) => toRecord(t)),
      };
    });
  }),

  /** The consent transparency screen, generated from declarations (module2.md §6.2). */
  consent: procedure
    .input(z.object({ kind: ConnectorKind, tools: z.array(z.string()).max(200) }))
    .query(({ ctx, input }) => {
      requireCapability(ctx, 'connectors.read');
      const def = definitionFor(connectorDeps(ctx), input.kind);
      scopesFor(ctx, input.kind, input.tools);
      return consentModel(def, input.tools);
    }),

  list: procedure.input(PageQuery.extend({ kind: ConnectorKind.optional() })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.read');
    const cursor = decodeCursor(input.cursor);
    const rows = await ctx.db((db) =>
      db
        .select()
        .from(schema.connectors)
        .where(
          and(
            input.kind ? eq(schema.connectors.kind, input.kind) : undefined,
            afterCursor(schema.connectors.createdAt, schema.connectors.id, cursor),
          ),
        )
        .orderBy(...newestFirst(schema.connectors.createdAt, schema.connectors.id))
        .limit(input.limit + 1),
    );
    return page(rows, input.limit, toConnector);
  }),

  get: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.read');
    return toConnector(await loadConnector(ctx, input.id));
  }),

  create: procedure.input(CreateConnector).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.manage');
    const d = connectorDeps(ctx);
    const def = definitionFor(d, input.kind);
    const provider = providerOf(def);
    const scopes = scopesFor(ctx, input.kind, input.enabledTools);
    const config = checkConfig(input.kind, input.config);
    if (provider && !d.oauthClients[provider]) {
      throw new ProblemError(problems.preconditionFailed(`no OAuth client is configured for ${provider}`));
    }

    const row = await ctx.db(async (db) => {
      const [created] = await db
        .insert(schema.connectors)
        .values({
          tenantId: ctx.principal.tenantId,
          workspaceId: input.workspaceId ?? null,
          kind: input.kind,
          displayName: input.displayName,
          ownerUserId: ctx.principal.userId,
          scopesRequired: scopes,
          enabledTools: input.enabledTools,
          config,
          // Credential-less connectors (web, http) are usable immediately.
          status: provider ? 'pending' : 'active',
        })
        .returning();
      await connectorEvent(db, ctx.principal.tenantId, created!.id, 'created', { kind: input.kind, enabledTools: input.enabledTools });
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'connector.created', { connectorId: created!.id, kind: input.kind });
      return created!;
    });
    return { connector: toConnector(row), authorizeUrl: provider ? consentUrl(ctx, row, scopes) : null };
  }),

  /**
   * Enabling a tool whose scopes are not granted does NOT widen the grant silently: the tool
   * is recorded as enabled, the runtime refuses it until granted, and the response carries the
   * re-consent URL (incremental authorization, module2.md §5.5).
   */
  update: procedure.input(UpdateConnector.extend({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.manage');
    const current = await loadConnector(ctx, input.id);
    if (current.status === 'revoked') throw new ProblemError(problems.preconditionFailed('revoked connectors cannot be modified'));
    let scopes = current.scopesRequired;
    if (input.enabledTools) {
      if (current.kind === 'mcp') {
        const known = await mcpToolIds(ctx, current.id);
        const unknown = input.enabledTools.filter((t) => !known.has(t));
        if (unknown.length) throw new ProblemError(problems.validation([{ path: 'enabledTools', message: `not tools of this server: ${unknown.join(', ')}` }]));
        scopes = [];
      } else {
        scopes = scopesFor(ctx, current.kind, input.enabledTools);
      }
    }
    const config = input.config ? (current.kind === 'mcp' ? current.config : checkConfig(current.kind, input.config)) : current.config;
    const row = await ctx.db(async (db) => {
      const [updated] = await db
        .update(schema.connectors)
        .set({
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
          ...(input.enabledTools ? { enabledTools: input.enabledTools, scopesRequired: scopes } : {}),
          config,
        })
        .where(eq(schema.connectors.id, input.id))
        .returning();
      await connectorEvent(db, ctx.principal.tenantId, input.id, 'updated', { fields: Object.keys(input).filter((k) => k !== 'id') });
      return updated!;
    });
    const granted = new Set(row.scopesGranted);
    const missing = scopes.filter((s) => !granted.has(s));
    const needsConsent = missing.length > 0 && providerOf(definitionFor(connectorDeps(ctx), row.kind)) !== null;
    return { connector: toConnector(row), authorizeUrl: needsConsent ? consentUrl(ctx, row, scopes) : null };
  }),

  reauthorize: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.manage');
    const row = await loadConnector(ctx, input.id);
    if (row.status === 'revoked') throw new ProblemError(problems.preconditionFailed('revoked connectors cannot be re-authorized; create a new one'));
    return { authorizeUrl: consentUrl(ctx, row, row.scopesRequired) };
  }),

  /** The OAuth callback, forwarded by the gateway with the caller's own session. */
  completeOAuth: procedure
    .input(z.object({ provider: z.enum(['google', 'microsoft', 'slack']), code: z.string().min(1).max(4096), state: z.string().min(1).max(8192) }))
    .mutation(async ({ ctx, input }) => {
      requireCapability(ctx, 'connectors.manage');
      const d = connectorDeps(ctx);
      const state = stateSealer(d).open<OAuthState>(input.state);
      // Tampered, expired, or minted for someone else: indistinguishable on purpose.
      if (!state || state.t !== ctx.principal.tenantId || state.u !== ctx.principal.userId || state.p !== input.provider) {
        throw new ProblemError(problems.forbidden('invalid or expired authorization state'));
      }
      const row = await loadConnector(ctx, state.c);
      if (row.status === 'revoked') throw new ProblemError(problems.preconditionFailed('connector was revoked during authorization'));
      const client = d.oauthClients[input.provider as OAuthProvider];
      if (!client) throw new ProblemError(problems.preconditionFailed(`no OAuth client is configured for ${input.provider}`));

      let tokens;
      try {
        tokens = await exchangeCode(PROVIDERS[input.provider], client, { code: input.code, codeVerifier: state.v, requestedScopes: state.s });
      } catch (error) {
        ctx.log.warn({ err: error, connectorId: row.id }, 'authorization code exchange failed');
        await ctx.db((db) => connectorEvent(db, ctx.principal.tenantId, row.id, 'authorization_failed', { code: error instanceof OAuthError ? error.code : 'unknown' }));
        throw new ProblemError(problems.preconditionFailed('the provider rejected the authorization; try again'));
      }

      const secretRefId = await d.vault.save(ctx.principal.tenantId, tokens, row.secretRefId ?? undefined);
      const updated = await ctx.db(async (db) => {
        const [u] = await db
          .update(schema.connectors)
          .set({ secretRefId, scopesGranted: tokens.scopesGranted, status: 'active' })
          .where(eq(schema.connectors.id, row.id))
          .returning();
        await connectorEvent(db, ctx.principal.tenantId, row.id, 'authorized', { scopes: tokens.scopesGranted });
        await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'connector.authorized', { connectorId: row.id, kind: row.kind });
        return u!;
      });

      const report = await probe(ctx, row.id);
      if (report.duplicateAccount) {
        // The same provider account is already connected: keep the existing connection.
        await revokeCredential(ctx, updated);
        await ctx.db((db) => db.update(schema.connectors).set({ status: 'revoked', enabledTools: [] }).where(eq(schema.connectors.id, row.id)));
        throw new ProblemError(problems.conflict('this account is already connected'));
      }
      return { connector: toConnector(await loadConnector(ctx, row.id)), health: report };
    }),

  remove: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.manage');
    const row = await loadConnector(ctx, input.id);
    if (row.status === 'revoked') return toConnector(row);
    // Unusable first: the runtime refuses a revoked connector whatever happens next.
    await ctx.db((db) => db.update(schema.connectors).set({ status: 'revoked', enabledTools: [] }).where(eq(schema.connectors.id, row.id)));
    const confirmed = await revokeCredential(ctx, row);
    const final = await ctx.db(async (db) => {
      await connectorEvent(db, ctx.principal.tenantId, row.id, 'revoked', { providerConfirmed: confirmed });
      await emitEvent(db, ctx.principal.tenantId, ctx.principal.userId, 'connector.revoked', { connectorId: row.id, providerConfirmed: confirmed });
      const [r] = await db.select().from(schema.connectors).where(eq(schema.connectors.id, row.id));
      return r!;
    });
    return toConnector(final);
  }),

  test: procedure.input(z.object({ id: Uuid })).mutation(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.manage');
    await loadConnector(ctx, input.id);
    try {
      const report = await connectorDeps(ctx).execution.health(ctx.principal.tenantId, input.id);
      return { ok: report.ok, latencyMs: report.latencyMs, ...(report.detail ? { detail: report.detail } : {}) };
    } catch (error) {
      return asProblem(error);
    }
  }),

  health: procedure.input(z.object({ id: Uuid })).query(async ({ ctx, input }) => {
    requireCapability(ctx, 'connectors.read');
    const row = await loadConnector(ctx, input.id);
    const events = await ctx.db((db) =>
      db
        .select()
        .from(schema.connectorEvents)
        .where(eq(schema.connectorEvents.connectorId, input.id))
        .orderBy(desc(schema.connectorEvents.createdAt), desc(schema.connectorEvents.id))
        .limit(25),
    );
    return {
      status: row.status,
      lastOkAt: row.lastOkAt ? row.lastOkAt.toISOString() : null,
      health: row.healthJson as Record<string, unknown>,
      events: events.map((e) => ({ kind: e.kind, detail: e.detail as Record<string, unknown>, createdAt: e.createdAt.toISOString() })),
    };
  }),
});
