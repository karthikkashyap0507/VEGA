import { desc, eq, sql } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';

/**
 * THE CONTACT LEDGER — docs/module10.md §10.2. One global record per external human, across
 * every agent and every run: "three will email the same prospect the same week" becomes
 * impossible to miss. Cooldowns are per relationship type; a second agent inside the window is
 * BLOCKED and told who holds the relationship.
 *
 * Identity resolution (§21): normalize aggressively and accept false positives over false
 * negatives — a wrongly-blocked send is a retry; a duplicate send to a client is the incident.
 */
export type Channel = 'email' | 'slack' | 'calendar';
export type Relationship = 'prospect' | 'client' | 'vendor' | 'internal';

export const DAY = 86_400_000;
export const DEFAULT_COOLDOWN_MS: Record<Relationship, number> = { prospect: 5 * DAY, client: 1 * DAY, vendor: 1 * DAY, internal: 0 };
/** An external human we know nothing about is treated like a client: a day, not five, not none. */
const UNKNOWN_COOLDOWN_MS = 1 * DAY;

/** `Peter.Smith+newsletter@GoogleMail.com` and `peter.smith@gmail.com` are one person. */
export function normalizeIdentity(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^mailto:/, '').replace(/^.*<([^>]+)>.*$/, '$1');
  const at = s.lastIndexOf('@');
  if (at < 1) return s; // a Slack handle or phone number: as written, lower-cased
  let local = s.slice(0, at);
  let domain = s.slice(at + 1);
  local = local.replace(/\+.*$/, '');
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

export interface ContactAttempt {
  tenantId: string;
  identity: string;
  channel: Channel;
  runId: string;
  agentId: string;
  onBehalfOf: string;
  relationship?: Relationship | null;
  at?: Date;
}

export type ContactResult =
  | { ok: true; ledgerId: string; cooldownUntil: Date; identity: string }
  | { ok: false; identity: string; blockedBy: { agentId: string; runId: string; onBehalfOf: string; contactedAt: Date; cooldownUntil: Date; relationship: string | null }; retryAfter: Date; message: string };

export class ContactLedger {
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly cooldowns: Record<Relationship, number> = DEFAULT_COOLDOWN_MS,
  ) {}

  cooldownFor(rel?: Relationship | null): number {
    return rel ? this.cooldowns[rel] : UNKNOWN_COOLDOWN_MS;
  }

  /** Read-only: would this contact be blocked right now? (The early, pre-approval check.) */
  async check(tenantId: string, identity: string, now = this.now(), exceptRunId?: string): Promise<Extract<ContactResult, { ok: false }> | null> {
    const id = normalizeIdentity(identity);
    return withTenant(tenantId, async (db) => this.blocking(db, id, now, exceptRunId));
  }

  /**
   * Check-and-record, atomically per identity: two agents racing for the same human cannot both
   * pass (§19 "zero duplicates inside cooldown"). A same-RUN repeat is not a second contact
   * attempt by someone else, so it passes — the cooldown protects humans from different runs.
   */
  async attempt(a: ContactAttempt): Promise<ContactResult> {
    const id = normalizeIdentity(a.identity);
    const at = a.at ?? this.now();
    return withTenant(a.tenantId, async (db) => {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`contact:${a.tenantId}:${id}`}))`);
      const blocked = await this.blocking(db, id, at, a.runId);
      if (blocked) return blocked;
      const cooldownUntil = new Date(at.getTime() + this.cooldownFor(a.relationship));
      const [row] = await db
        .insert(schema.contactLedger)
        .values({ tenantId: a.tenantId, externalIdentity: id, channel: a.channel, contactedAt: at, byRunId: a.runId, byAgentId: a.agentId, onBehalfOf: a.onBehalfOf, relationshipType: a.relationship ?? null, cooldownUntil })
        .returning({ id: schema.contactLedger.id });
      return { ok: true as const, ledgerId: row!.id, cooldownUntil, identity: id };
    });
  }

  /** An audited exception (§18): a reason is required, and the ledger row says it was one. */
  async override(a: ContactAttempt & { by: string; reason: string }): Promise<{ ledgerId: string; identity: string }> {
    if (!a.reason.trim()) throw new Error('a contact override needs a reason');
    const id = normalizeIdentity(a.identity);
    const at = a.at ?? this.now();
    return withTenant(a.tenantId, async (db) => {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`contact:${a.tenantId}:${id}`}))`);
      const [row] = await db
        .insert(schema.contactLedger)
        .values({ tenantId: a.tenantId, externalIdentity: id, channel: a.channel, contactedAt: at, byRunId: a.runId, byAgentId: a.agentId, onBehalfOf: a.onBehalfOf, relationshipType: a.relationship ?? null, cooldownUntil: new Date(at.getTime() + this.cooldownFor(a.relationship)), overrideReason: a.reason, overriddenBy: a.by })
        .returning({ id: schema.contactLedger.id });
      await db.insert(schema.platformEvents).values({ tenantId: a.tenantId, actorId: a.by, kind: 'contact.override', payload: { identity: id, runId: a.runId, agentId: a.agentId, reason: a.reason } });
      return { ledgerId: row!.id, identity: id };
    });
  }

  async history(tenantId: string, identity?: string, limit = 100) {
    return withTenant(tenantId, async (db) => {
      const q = db.select().from(schema.contactLedger);
      const rows = await (identity ? q.where(eq(schema.contactLedger.externalIdentity, normalizeIdentity(identity))) : q).orderBy(desc(schema.contactLedger.contactedAt)).limit(limit);
      const now = this.now();
      return rows.map((r) => ({ ...r, inCooldown: r.cooldownUntil > now }));
    });
  }

  private async blocking(db: Parameters<Parameters<typeof withTenant>[1]>[0], identity: string, at: Date, exceptRun?: string): Promise<Extract<ContactResult, { ok: false }> | null> {
    const rows = await db.select().from(schema.contactLedger).where(eq(schema.contactLedger.externalIdentity, identity)).orderBy(desc(schema.contactLedger.contactedAt)).limit(20);
    // An audited override (§18) exempts the run it was made for: a person looked at this contact and allowed it.
    if (exceptRun && rows.some((r) => r.byRunId === exceptRun && r.overriddenBy)) return null;
    const live = rows.find((r) => r.cooldownUntil > at && r.byRunId !== exceptRun);
    if (!live) return null;
    const hours = Math.max(1, Math.floor((at.getTime() - live.contactedAt.getTime()) / 3_600_000));
    const left = Math.max(1, Math.floor((live.cooldownUntil.getTime() - at.getTime()) / 3_600_000));
    const span = (h: number) => (h >= 48 ? `${Math.floor(h / 24)} days` : `${h} hour${h === 1 ? '' : 's'}`);
    return {
      ok: false,
      identity,
      blockedBy: { agentId: live.byAgentId, runId: live.byRunId, onBehalfOf: live.onBehalfOf, contactedAt: live.contactedAt, cooldownUntil: live.cooldownUntil, relationship: live.relationshipType },
      retryAfter: live.cooldownUntil,
      message: `Cannot contact ${identity}: another agent contacted them ${span(hours)} ago. Cooldown ends in ${span(left)}.`,
    };
  }
}
