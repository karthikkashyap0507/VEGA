import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * THE ONE-TAP REVOKE — docs/module6.md §5.5, §10: "revoke requires no login challenge". A push
 * notification carries a capability that can do exactly one thing — revoke one hold — until the
 * hold ends. Only its SHA-256 is stored. The tenant id rides in the clear (it is not a secret) so
 * the public endpoint can open the tenant's context before looking the hash up.
 *
 * Revoking is the safe action: a leaked capability can stop an email, never send one.
 */
const PREFIX = 'hr1';

export function mintRevokeToken(tenantId: string): { token: string; hash: string } {
  const token = `${PREFIX}.${tenantId.replace(/-/g, '')}.${randomBytes(32).toString('base64url')}`;
  return { token, hash: revokeTokenHash(token) };
}

export function revokeTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function parseRevokeToken(token: string): { tenantId: string; hash: string } | null {
  const m = /^hr1\.([0-9a-f]{32})\.[A-Za-z0-9_-]{43}$/.exec(token);
  if (!m) return null;
  const h = m[1]!;
  const tenantId = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return { tenantId, hash: revokeTokenHash(token) };
}

/**
 * A person's push topic (ntfy): unguessable, stable, derived from their user id with a secret
 * both planes hold. The execution plane publishes held actions to it; the console shows it so
 * the person can subscribe on their phone.
 */
export function pushTopic(userId: string, secret: string): string {
  return `hold-${createHmac('sha256', secret).update(userId).digest('base64url').slice(0, 24)}`;
}

/** Valkey keys of the fast revoke path (§9): precomputed authorization, no policy round trip. */
export const fastRevokeKeys = {
  hold: (holdId: string) => `vega:hold:${holdId}`,
  token: (hash: string) => `vega:holdtok:${hash}`,
};

export interface FastRevokeEntry {
  tenantId: string;
  runId: string;
  holdId: string;
  toolId: string;
  allowed: string[];
  expiresAt: string;
}
