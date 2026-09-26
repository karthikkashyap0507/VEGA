import { createHash } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';

/**
 * Idempotency-Key — module1.md §7.2: "Every mutating endpoint accepts Idempotency-Key; stored
 * 24h." Implementation plan Step 5 DoD: "double-POST with the same idempotency key produces
 * one effect."
 *
 * Keyed per (tenant, principal, key). The first request claims the key (`in_progress`) BEFORE
 * doing anything, so a concurrent duplicate cannot slip through; the response is stored when
 * the first completes. A 5xx releases the key, because a server failure is the case a client
 * retry is for. Reusing a key with a different request is a client bug and gets a 422.
 */

export const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export type Claim =
  | { kind: 'fresh' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'in_progress' }
  | { kind: 'mismatch' };

export function requestHash(method: string, path: string, body: unknown): Buffer {
  return createHash('sha256')
    .update(method)
    .update('\n')
    .update(path)
    .update('\n')
    .update(canonical(body))
    .digest();
}

/** Canonical JSON: key order must not make "the same request" look different. */
function canonical(value: unknown): string {
  if (value === undefined) return '';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

export async function claim(input: {
  tenantId: string;
  principalId: string;
  key: string;
  method: string;
  path: string;
  hash: Buffer;
}): Promise<Claim> {
  return withTenant(input.tenantId, async (db) => {
    const where = and(
      eq(schema.idempotencyKeys.tenantId, input.tenantId),
      eq(schema.idempotencyKeys.principalId, input.principalId),
      eq(schema.idempotencyKeys.key, input.key),
    );
    // Expired records are treated as absent (the 24h horizon).
    await db.delete(schema.idempotencyKeys).where(and(where, lt(schema.idempotencyKeys.expiresAt, new Date())));

    const inserted = await db
      .insert(schema.idempotencyKeys)
      .values({
        tenantId: input.tenantId,
        principalId: input.principalId,
        key: input.key,
        method: input.method,
        path: input.path,
        requestHash: input.hash,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      })
      .onConflictDoNothing()
      .returning({ key: schema.idempotencyKeys.key });
    if (inserted.length > 0) return { kind: 'fresh' };

    const [existing] = await db.select().from(schema.idempotencyKeys).where(where);
    if (!existing) return { kind: 'fresh' };
    if (!existing.requestHash.equals(input.hash)) return { kind: 'mismatch' };
    if (existing.state === 'completed' && existing.statusCode !== null) {
      return { kind: 'replay', status: existing.statusCode, body: existing.responseBody };
    }
    return { kind: 'in_progress' };
  });
}

export async function complete(
  input: { tenantId: string; principalId: string; key: string },
  status: number,
  body: unknown,
): Promise<void> {
  await withTenant(input.tenantId, async (db) => {
    const where = and(
      eq(schema.idempotencyKeys.tenantId, input.tenantId),
      eq(schema.idempotencyKeys.principalId, input.principalId),
      eq(schema.idempotencyKeys.key, input.key),
    );
    if (status >= 500) {
      await db.delete(schema.idempotencyKeys).where(where);
      return;
    }
    await db
      .update(schema.idempotencyKeys)
      .set({ state: 'completed', statusCode: status, responseBody: (body ?? null) as never })
      .where(where);
  });
}
