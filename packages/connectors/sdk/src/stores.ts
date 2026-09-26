import { and, eq, sql } from 'drizzle-orm';
import { openSecretAsString, sealSecret } from '@vega/shared';
import { schema, withTenant } from '@vega/db';
import type { ConnectorStatus, Effect } from '@vega/contracts';
import type { ConnectorTokens } from './oauth.js';
import type { ConnectorRecord, ConnectorStore, InvocationClaim, InvocationStore, TokenVault } from './runtime.js';

/**
 * Postgres implementations of the runtime's stores. Every query runs under withTenant(): the
 * connector runtime lives in the execution plane and gets exactly the same tenant isolation
 * as the control plane (module1.md §4.1).
 */

export class PgConnectorStore implements ConnectorStore {
  async get(tenantId: string, connectorId: string): Promise<ConnectorRecord | undefined> {
    const [row] = await withTenant(tenantId, (db) =>
      db.select().from(schema.connectors).where(eq(schema.connectors.id, connectorId)),
    );
    if (!row) return undefined;
    return {
      id: row.id,
      tenantId: row.tenantId,
      kind: row.kind as ConnectorRecord['kind'],
      status: row.status as ConnectorStatus,
      scopesGranted: row.scopesGranted,
      enabledTools: row.enabledTools,
      config: row.config as Record<string, unknown>,
      secretRefId: row.secretRefId,
    };
  }

  async setStatus(tenantId: string, connectorId: string, status: ConnectorStatus, health?: Record<string, unknown>) {
    await withTenant(tenantId, (db) =>
      db
        .update(schema.connectors)
        .set({ status, ...(health ? { healthJson: health } : {}) })
        .where(eq(schema.connectors.id, connectorId)),
    );
  }

  async markOk(tenantId: string, connectorId: string) {
    await withTenant(tenantId, (db) =>
      db.update(schema.connectors).set({ lastOkAt: new Date() }).where(eq(schema.connectors.id, connectorId)),
    );
  }

  async event(tenantId: string, connectorId: string, kind: string, detail: Record<string, unknown> = {}) {
    await withTenant(tenantId, (db) => db.insert(schema.connectorEvents).values({ tenantId, connectorId, kind, detail }));
  }

  async internalDomains(tenantId: string): Promise<string[]> {
    const rows = await withTenant(tenantId, async (db) => {
      const [t] = await db.select({ settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      const users = await db.select({ email: schema.users.email }).from(schema.users);
      return { settings: (t?.settings ?? {}) as { internalDomains?: string[] }, users };
    });
    // Explicit configuration wins; otherwise the domains the tenant's own users sign in with.
    if (rows.settings.internalDomains?.length) return rows.settings.internalDomains.map((d) => d.toLowerCase());
    return [...new Set(rows.users.map((u) => u.email.split('@')[1]?.toLowerCase()).filter((d): d is string => Boolean(d)))];
  }
}

/**
 * Connector credentials in secret_refs, envelope-encrypted (module1.md §4, module2.md §10.1).
 * Plaintext exists only in memory for the duration of a call; it never reaches Postgres, logs,
 * traces or error messages.
 */
export class PgTokenVault implements TokenVault {
  constructor(private readonly kek?: Buffer) {}

  async load(tenantId: string, secretRefId: string): Promise<ConnectorTokens> {
    const [row] = await withTenant(tenantId, (db) =>
      db.select().from(schema.secretRefs).where(eq(schema.secretRefs.id, secretRefId)),
    );
    if (!row) throw new Error('connector secret not found');
    return JSON.parse(
      openSecretAsString(
        { wrappedDek: row.wrappedDek, ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag, kmsKeyId: row.kmsKeyId },
        this.kek,
      ),
    ) as ConnectorTokens;
  }

  async save(tenantId: string, tokens: ConnectorTokens, secretRefId?: string): Promise<string> {
    const sealed = sealSecret(JSON.stringify(tokens), this.kek);
    const values = {
      kmsKeyId: sealed.kmsKeyId,
      wrappedDek: sealed.wrappedDek,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
    };
    return withTenant(tenantId, async (db) => {
      if (secretRefId) {
        await db
          .update(schema.secretRefs)
          .set({ ...values, rotatedAt: new Date() })
          .where(eq(schema.secretRefs.id, secretRefId));
        return secretRefId;
      }
      const [row] = await db
        .insert(schema.secretRefs)
        .values({ tenantId, purpose: 'connector_oauth', ...values, meta: { scopes: tokens.scopesGranted } })
        .returning({ id: schema.secretRefs.id });
      return row!.id;
    });
  }

  async delete(tenantId: string, secretRefId: string): Promise<void> {
    await withTenant(tenantId, async (db) => {
      await db.update(schema.connectors).set({ secretRefId: null }).where(eq(schema.connectors.secretRefId, secretRefId));
      await db.delete(schema.secretRefs).where(eq(schema.secretRefs.id, secretRefId));
    });
  }
}

/**
 * The idempotency ledger (module2.md §4 tool_invocations). The claim is an INSERT that either
 * wins or tells the caller what already happened — two executors racing on one key cannot
 * both proceed, because the unique constraint decides.
 */
export class PgInvocationStore implements InvocationStore {
  async claim(input: { tenantId: string; connectorId: string; toolId: string; key: string; argsDigest: string }): Promise<InvocationClaim> {
    return withTenant(input.tenantId, async (db) => {
      const inserted = await db
        .insert(schema.toolInvocations)
        .values({
          tenantId: input.tenantId,
          connectorId: input.connectorId,
          toolId: input.toolId,
          idempotencyKey: input.key,
          argsDigest: input.argsDigest,
        })
        .onConflictDoNothing()
        .returning({ id: schema.toolInvocations.id });
      if (inserted.length) return { kind: 'fresh' as const };

      const [prior] = await db
        .select()
        .from(schema.toolInvocations)
        .where(and(eq(schema.toolInvocations.toolId, input.toolId), eq(schema.toolInvocations.idempotencyKey, input.key)))
        .for('update');
      if (!prior) return { kind: 'fresh' as const };
      if (prior.argsDigest !== input.argsDigest) return { kind: 'mismatch' as const };
      if (prior.state === 'succeeded' && prior.effectJson) {
        return {
          kind: 'replay' as const,
          effect: prior.effectJson as Effect<unknown>,
          ...(prior.responseRef ? { providerRef: prior.responseRef } : {}),
        };
      }
      // A released failure (nothing happened) can be claimed again.
      if (prior.state === 'failed') {
        await db
          .update(schema.toolInvocations)
          .set({ state: 'in_flight', startedAt: new Date(), finishedAt: null, errorCode: null })
          .where(eq(schema.toolInvocations.id, prior.id));
        return { kind: 'fresh' as const };
      }
      return { kind: 'in_flight' as const };
    });
  }

  async succeed(tenantId: string, toolId: string, key: string, effect: Effect<unknown>, providerRef?: string) {
    await withTenant(tenantId, (db) =>
      db
        .update(schema.toolInvocations)
        .set({ state: 'succeeded', effectJson: effect, responseRef: providerRef ?? null, finishedAt: sql`now()` })
        .where(and(eq(schema.toolInvocations.toolId, toolId), eq(schema.toolInvocations.idempotencyKey, key))),
    );
  }

  async fail(tenantId: string, toolId: string, key: string, code: string, release: boolean) {
    await withTenant(tenantId, (db) =>
      db
        .update(schema.toolInvocations)
        // An AMBIGUOUS failure stays in_flight: the effect may have happened, so the key must
        // not be reusable until someone (M6 verification) establishes what actually occurred.
        .set(release ? { state: 'failed', errorCode: code, finishedAt: sql`now()` } : { errorCode: code })
        .where(and(eq(schema.toolInvocations.toolId, toolId), eq(schema.toolInvocations.idempotencyKey, key))),
    );
  }
}
