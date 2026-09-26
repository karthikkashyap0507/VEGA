import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Logger } from '@vega/shared';
import { openSecretAsString, sealSecret, type EnvelopeSecret } from '@vega/shared';
import { resolveSessionToken, schema, withTenant } from '@vega/db';
import type { OidcClient } from '@vega/idp';

/**
 * Browser/API sessions — module1.md §8.1, §10 ("short TTL; refresh rotation").
 *
 * The credential is an opaque 256-bit token. The database stores only its SHA-256, so a read
 * of `sessions` yields nothing a caller can present.
 *
 * ROTATION. A token older than the rotation interval is replaced on its next use. The
 * replaced hash stays valid for GRACE_SECONDS, which absorbs the parallel requests of a single
 * page load. Presenting it after that window means two parties hold the same session — the
 * classic stolen-refresh-token signal — and the WHOLE session is revoked.
 *
 * UPSTREAM RE-CHECK. When a session rotates and the IdP has not been consulted for a TTL,
 * the sealed IdP refresh token is used to confirm the user is still allowed in. An explicit
 * refusal (invalid_grant) revokes the session; an IdP outage does not, so a Zitadel incident
 * does not sign out every user at once.
 */

export const GRACE_SECONDS = 30;

export interface SessionPrincipal {
  sessionId: string;
  tenantId: string;
  userId: string;
}

export interface ResolveResult extends SessionPrincipal {
  /** Set when the token was rotated; the caller must deliver it to the client. */
  rotatedToken?: string;
  expiresAt: Date;
}

export interface SessionServiceOptions {
  ttlSeconds: number;
  absoluteTtlSeconds: number;
  /** Rotate once the current token is this old. Defaults to min(15 min, ttl/4). */
  rotateAfterSeconds?: number;
  kek?: Buffer;
  oidc?: OidcClient;
  logger: Logger;
}

interface IdpTokens {
  refreshToken?: string;
  idToken?: string;
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export class SessionService {
  private readonly rotateAfterMs: number;

  constructor(private readonly options: SessionServiceOptions) {
    this.rotateAfterMs =
      (options.rotateAfterSeconds ?? Math.min(15 * 60, Math.floor(options.ttlSeconds / 4))) * 1000;
  }

  private seal(tokens: IdpTokens): EnvelopeSecret | undefined {
    if (!tokens.refreshToken && !tokens.idToken) return undefined;
    return sealSecret(JSON.stringify(tokens), this.options.kek);
  }

  private open(row: typeof schema.sessions.$inferSelect): IdpTokens {
    if (!row.idpCiphertext || !row.idpWrappedDek || !row.idpIv || !row.idpAuthTag) return {};
    try {
      return JSON.parse(
        openSecretAsString(
          {
            wrappedDek: row.idpWrappedDek,
            ciphertext: row.idpCiphertext,
            iv: row.idpIv,
            authTag: row.idpAuthTag,
            kmsKeyId: row.idpKmsKeyId ?? 'local',
          },
          this.options.kek,
        ),
      ) as IdpTokens;
    } catch (error) {
      this.options.logger.warn({ err: error }, 'sealed IdP tokens could not be opened');
      return {};
    }
  }

  async create(input: {
    tenantId: string;
    userId: string;
    idp?: IdpTokens;
    userAgent?: string;
    ip?: string;
  }): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const token = newToken();
    const now = Date.now();
    const absolute = new Date(now + this.options.absoluteTtlSeconds * 1000);
    const expiresAt = new Date(Math.min(now + this.options.ttlSeconds * 1000, absolute.getTime()));
    const sealed = input.idp ? this.seal(input.idp) : undefined;

    const [row] = await withTenant(input.tenantId, (db) =>
      db
        .insert(schema.sessions)
        .values({
          tenantId: input.tenantId,
          userId: input.userId,
          tokenHash: hashToken(token),
          expiresAt,
          absoluteExpiresAt: absolute,
          userAgent: input.userAgent?.slice(0, 512) ?? null,
          ip: input.ip ?? null,
          ...(sealed
            ? {
                idpWrappedDek: sealed.wrappedDek,
                idpCiphertext: sealed.ciphertext,
                idpIv: sealed.iv,
                idpAuthTag: sealed.authTag,
                idpKmsKeyId: sealed.kmsKeyId,
              }
            : {}),
        })
        .returning({ id: schema.sessions.id }),
    );
    return { token, sessionId: row!.id, expiresAt };
  }

  /** Resolves a presented token. Returns undefined for anything that is not a live session. */
  async resolve(token: string, options: { forceRotate?: boolean } = {}): Promise<ResolveResult | undefined> {
    if (!token || token.length > 256) return undefined;
    const hash = hashToken(token);
    const found = await resolveSessionToken(hash);
    if (!found || found.revokedAt) return undefined;

    const now = new Date();
    if (now > found.absoluteExpiresAt) return undefined;

    if (found.matched === 'previous') {
      if (found.previousValidUntil && now <= found.previousValidUntil) {
        return { sessionId: found.sessionId, tenantId: found.tenantId, userId: found.userId, expiresAt: found.expiresAt };
      }
      // A rotated-away token, presented after its grace window: someone else has it.
      await this.revoke(found.tenantId, found.sessionId, 'token_reuse_detected');
      this.options.logger.warn(
        { tenant_id: found.tenantId, session_id: found.sessionId },
        'SECURITY: rotated session token reused after grace window; session revoked',
      );
      return undefined;
    }

    if (now > found.expiresAt) return undefined;

    return withTenant(found.tenantId, async (db) => {
      // Row lock: two concurrent requests with the same token must not both rotate it, or
      // the first one's new token would itself be rotated away and later flagged as reuse.
      const [row] = await db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.id, found.sessionId))
        .for('update');
      if (!row || row.revokedAt) return undefined;

      const base = { sessionId: row.id, tenantId: row.tenantId, userId: row.userId };
      if (!row.tokenHash.equals(hash)) {
        // Rotated by a concurrent request between resolve and lock: honour the grace window.
        return { ...base, expiresAt: row.expiresAt };
      }

      const due = options.forceRotate || now.getTime() - row.rotatedAt.getTime() >= this.rotateAfterMs;
      if (!due) {
        if (now.getTime() - row.lastSeenAt.getTime() > 60_000) {
          await db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, row.id));
        }
        return { ...base, expiresAt: row.expiresAt };
      }

      // Upstream re-check, at most once per TTL, and only on rotation.
      let sealedUpdate: Partial<typeof schema.sessions.$inferInsert> = {};
      if (this.options.oidc && now.getTime() - row.idpCheckedAt.getTime() >= this.options.ttlSeconds * 1000) {
        const tokens = this.open(row);
        if (tokens.refreshToken) {
          try {
            const refreshed = await this.options.oidc.refresh(tokens.refreshToken);
            const idToken = refreshed.idToken || tokens.idToken;
            const sealed = this.seal({
              refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
              ...(idToken ? { idToken } : {}),
            });
            sealedUpdate = {
              idpCheckedAt: now,
              ...(sealed
                ? {
                    idpWrappedDek: sealed.wrappedDek,
                    idpCiphertext: sealed.ciphertext,
                    idpIv: sealed.iv,
                    idpAuthTag: sealed.authTag,
                    idpKmsKeyId: sealed.kmsKeyId,
                  }
                : {}),
            };
          } catch (error) {
            const code = (error as { code?: string }).code;
            if (code === 'invalid_grant') {
              await db
                .update(schema.sessions)
                .set({ revokedAt: now, revokeReason: 'idp_refused_refresh' })
                .where(eq(schema.sessions.id, row.id));
              return undefined;
            }
            this.options.logger.warn({ err: error }, 'IdP re-check unavailable; keeping session');
          }
        }
      }

      const rotated = newToken();
      const expiresAt = new Date(
        Math.min(now.getTime() + this.options.ttlSeconds * 1000, row.absoluteExpiresAt.getTime()),
      );
      await db
        .update(schema.sessions)
        .set({
          previousTokenHash: row.tokenHash,
          previousValidUntil: new Date(now.getTime() + GRACE_SECONDS * 1000),
          tokenHash: hashToken(rotated),
          rotatedAt: now,
          lastSeenAt: now,
          expiresAt,
          ...sealedUpdate,
        })
        .where(eq(schema.sessions.id, row.id));
      return { ...base, rotatedToken: rotated, expiresAt };
    });
  }

  async revoke(tenantId: string, sessionId: string, reason: string): Promise<IdpTokens> {
    return withTenant(tenantId, async (db) => {
      const [row] = await db
        .update(schema.sessions)
        .set({ revokedAt: new Date(), revokeReason: reason })
        .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)))
        .returning();
      return row ? this.open(row) : {};
    });
  }

  async listActive(tenantId: string, userId: string) {
    return withTenant(tenantId, (db) =>
      db
        .select({
          id: schema.sessions.id,
          createdAt: schema.sessions.createdAt,
          lastSeenAt: schema.sessions.lastSeenAt,
          expiresAt: schema.sessions.expiresAt,
          userAgent: schema.sessions.userAgent,
          ip: schema.sessions.ip,
        })
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.userId, userId),
            isNull(schema.sessions.revokedAt),
            gt(schema.sessions.absoluteExpiresAt, new Date()),
          ),
        ),
    );
  }
}
