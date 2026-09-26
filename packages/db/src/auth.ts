import type pg from 'pg';
import { and, eq } from 'drizzle-orm';
import { getAppPool, withTenant } from './client.js';
import { platformEvents, users } from './schema.js';

/**
 * Typed wrappers for the two pre-tenant resolver functions (migrations/0002_identity.sql).
 *
 * These, and the work-discovery functions in scheduler.ts (Module 4), are the ONLY queries in
 * the system that run without a tenant context, and they can reach nothing but what the
 * SECURITY DEFINER functions return. They live here, in the one
 * package allowed a raw pool (DB-001), so the gateway never holds a connection it could
 * query freely.
 */

export interface ResolvedSubject {
  tenantId: string;
  userId: string;
  role: string;
  userStatus: 'active' | 'invited' | 'deactivated';
  tenantStatus: 'active' | 'suspended' | 'closed';
}

export async function resolveSubject(
  subject: string,
  pool: pg.Pool = getAppPool(),
): Promise<ResolvedSubject[]> {
  const { rows } = await pool.query<{
    tenant_id: string;
    user_id: string;
    role: string;
    user_status: ResolvedSubject['userStatus'];
    tenant_status: ResolvedSubject['tenantStatus'];
  }>('SELECT * FROM auth_resolve_subject($1)', [subject]);
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    userId: r.user_id,
    role: r.role,
    userStatus: r.user_status,
    tenantStatus: r.tenant_status,
  }));
}

export interface ResolvedSession {
  sessionId: string;
  tenantId: string;
  userId: string;
  matched: 'current' | 'previous';
  previousValidUntil: Date | null;
  expiresAt: Date;
  absoluteExpiresAt: Date;
  revokedAt: Date | null;
}

export async function resolveSessionToken(
  tokenHash: Buffer,
  pool: pg.Pool = getAppPool(),
): Promise<ResolvedSession | undefined> {
  const { rows } = await pool.query<{
    session_id: string;
    tenant_id: string;
    user_id: string;
    matched: 'current' | 'previous';
    previous_valid_until: Date | null;
    expires_at: Date;
    absolute_expires_at: Date;
    revoked_at: Date | null;
  }>('SELECT * FROM auth_resolve_session($1)', [tokenHash]);
  const r = rows[0];
  if (!r) return undefined;
  return {
    sessionId: r.session_id,
    tenantId: r.tenant_id,
    userId: r.user_id,
    matched: r.matched,
    previousValidUntil: r.previous_valid_until,
    expiresAt: r.expires_at,
    absoluteExpiresAt: r.absolute_expires_at,
    revokedAt: r.revoked_at,
  };
}

/**
 * First sign-in of an invited user flips them to `active` — the proof that the person
 * controls the identity the invite was sent to. Called only after the id_token has been
 * verified and its subject resolved; never from a request parameter.
 */
export async function activateInvitedUser(tenantId: string, userId: string): Promise<void> {
  await withTenant(tenantId, async (db) => {
    const updated = await db
      .update(users)
      .set({ status: 'active', lastSeenAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.status, 'invited')))
      .returning({ id: users.id });
    if (updated.length > 0) {
      await db.insert(platformEvents).values({ tenantId, actorId: userId, kind: 'user.activated', payload: {} });
    }
  });
}
