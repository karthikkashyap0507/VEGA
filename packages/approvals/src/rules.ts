import { createHash, randomBytes } from 'node:crypto';
import type { Fallback } from './packet.js';

/**
 * The timing and fallback rules — docs/module8.md §5.2, §5.3. Pure, so they are the same
 * wherever they are applied (the executor's timers, the control plane's dispatcher, the tests).
 */

export function durationMs(spec: string): number {
  const m = /^(\d+)([mhd])$/.exec(spec);
  if (!m) return 4 * 3_600_000;
  return Number(m[1]) * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
}

/**
 * "What happens if you do nothing" — stated on every packet; nothing hangs, nothing silently
 * proceeds. AUTO_APPROVE only for Low tier, only when configured, never for anything that leaves
 * the organization or cannot be undone; anything else asking for it gets AUTO_REJECT, and says why.
 */
export function effectiveFallback(i: { configured: Fallback; configuredRole?: string | null; tier: string | null; egress: string; reversibility: string; approverRole: string }): { fallback: Fallback; fallbackRole: string | null; note: string | null } {
  if (i.configured === 'AUTO_APPROVE') {
    const ok = i.tier === 'LOW' && i.egress === 'INTERNAL' && (i.reversibility === 'R0' || i.reversibility === 'R1');
    return ok ? { fallback: 'AUTO_APPROVE', fallbackRole: null, note: null } : { fallback: 'AUTO_REJECT', fallbackRole: null, note: 'auto-approve is only allowed for Low-tier internal actions that can be undone' };
  }
  if (i.configured === 'ESCALATE') {
    const role = i.configuredRole ?? (i.approverRole === 'OWNER' ? null : i.approverRole === 'ADMIN' ? 'OWNER' : 'ADMIN');
    return role ? { fallback: 'ESCALATE', fallbackRole: role, note: null } : { fallback: 'AUTO_REJECT', fallbackRole: null, note: 'there is no one above OWNER to escalate to' };
  }
  return { fallback: 'AUTO_REJECT', fallbackRole: null, note: null };
}

/** Urgent breaks the batch: Critical tier, or too little time to wait for a review moment. */
export const isUrgent = (tier: string | null, expiresInMs: number) => tier === 'CRITICAL' || expiresInMs <= 60 * 60_000;

/** Escalate an unanswered request after this fraction of its window (§5.4). */
export const ESCALATE_AFTER = 0.5;

/** Review moments (§5.3): default 09:00 / 13:00 / 17:00 in the tenant's offset from UTC. */
export function nextReviewMoment(now: Date, hours: readonly number[] = [9, 13, 17], utcOffsetMinutes = 0): Date {
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  for (let day = 0; day < 3; day++) {
    for (const h of [...hours].sort((a, b) => a - b)) {
      const t = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + day, h) - utcOffsetMinutes * 60_000;
      if (t > now.getTime()) return new Date(t);
    }
  }
  return new Date(now.getTime() + 86_400_000);
}

export const DEFAULT_DAILY_BUDGET = 12;

// ------------------------------------------------------------------ the one-tap reject capability
/**
 * A push carries a capability that can REJECT this one approval — no session, no login: stopping
 * is the safe action and must be the fastest (§6.3). Only its SHA-256 is stored.
 */
const PREFIX = 'ar1';
export function mintRejectToken(tenantId: string): { token: string; hash: string } {
  const token = `${PREFIX}.${tenantId.replace(/-/g, '')}.${randomBytes(32).toString('base64url')}`;
  return { token, hash: rejectTokenHash(token) };
}
export const rejectTokenHash = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
export const isRejectToken = (token: string) => /^ar1\.[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/.test(token);
