import { type ContactLedger, type LockManager, type WriteReconciler, normalizeIdentity, type Channel, type Relationship } from '@vega/contention';
import { schema, withTenant } from '@vega/db';
import type { StepContext } from '@vega/orchestration';
import type { ContentionPort, ContentionResult } from '../executor/pass.js';

/**
 * CONTENTION CONTROL AT THE EXECUTOR — docs/module10.md §10. Just before a consequential call:
 *
 *   1. for every external human it reaches: the contact ledger decides (cooldown by
 *      relationship; blocked and told who holds the relationship) and a COMMUNICATION lock makes
 *      sure only one agent is mid-send to them
 *   2. for every business record it touches: an EXCLUSIVE_WRITE lock on the ENTITY (not the
 *      row), and — where a field is written — a declared write that a concurrent different
 *      value conflicts with pre-commit (merge by rule, defer the lower priority, or a person)
 *
 * Communication locks are short (released right after the call); entity write locks are held
 * to the end of the run (§10.1 "automatic release on run termination") and re-entered freely
 * by that run's later steps.
 */
export interface GuardDeps {
  locks: LockManager;
  ledger: ContactLedger;
  reconciler: WriteReconciler;
  log: { warn(o: object, m: string): void };
  leaseMs?: number;
}

interface Handle {
  communication: string[];
  intents: string[];
}

const CHANNEL: Record<string, Channel> = { gmail: 'email', gcal: 'calendar', slack: 'slack' };

export class ContentionGuard implements ContentionPort {
  constructor(private readonly d: GuardDeps) {}

  /** Read-only, for the EARLY check (before a person is asked to approve a send that cannot happen). */
  async cooldown(tenantId: string, recipients: string[], exceptRunId: string): Promise<string | null> {
    for (const r of recipients) {
      const blocked = await this.d.ledger.check(tenantId, r, undefined, exceptRunId);
      if (blocked) return blocked.message;
    }
    return null;
  }

  private async blocked(ctx: StepContext, kind: string, message: string): Promise<void> {
    await withTenant(ctx.tenantId, (db) => db.insert(schema.platformEvents).values({ tenantId: ctx.tenantId, actorId: null, kind: 'contention.blocked', payload: { runId: ctx.runId, agentId: ctx.agentId, toolId: ctx.toolId, kind, message } })).catch(() => undefined);
  }

  async before(ctx: StepContext, effect: { externalRecipients: string[]; recordsAffected: Array<{ system: string; id: string; field?: string | undefined; after?: unknown }> }, o: { riskTier: string | null }): Promise<ContentionResult> {
    const out = await this.acquire(ctx, effect, o);
    if (!out.ok) await this.blocked(ctx, out.kind, out.message);
    return out;
  }

  private async acquire(ctx: StepContext, effect: { externalRecipients: string[]; recordsAffected: Array<{ system: string; id: string; field?: string | undefined; after?: unknown }> }, o: { riskTier: string | null }): Promise<ContentionResult> {
    const handle: Handle = { communication: [], intents: [] };
    const undo = async () => {
      for (const id of handle.communication) await this.d.locks.release(ctx.tenantId, id).catch(() => undefined);
      for (const id of handle.intents) await this.d.reconciler.complete(ctx.tenantId, id).catch(() => undefined);
    };
    const intent = `${ctx.toolId} for run ${ctx.runId.slice(0, 8)}`;
    const base = { tenantId: ctx.tenantId, runId: ctx.runId, agentId: ctx.agentId, intent, riskTier: o.riskTier, ...(this.d.leaseMs ? { leaseMs: this.d.leaseMs } : {}) };

    const recipients = [...new Set(effect.externalRecipients.map(normalizeIdentity))].sort();
    // canonical acquisition order (sorted) so two sends to the same pair of people cannot deadlock
    for (const r of recipients) {
      const res = await this.d.locks.acquire({ ...base, entityKey: `contact:${r}`, mode: 'COMMUNICATION' });
      if (!res.ok) {
        await undo();
        return { ok: false, kind: res.victim ? 'deadlock' : 'locked', message: res.victim ? `${res.reason}` : `${r} is being contacted by another agent right now (${res.heldBy.intent}); try again shortly.` };
      }
      handle.communication.push(res.lockId);
    }
    const records = [...new Map(effect.recordsAffected.map((x) => [`${x.system}:${x.id}`, x])).values()].sort((a, b) => (`${a.system}:${a.id}` < `${b.system}:${b.id}` ? -1 : 1));
    for (const rec of records) {
      const key = `${rec.system}:${rec.id}`;
      const res = await this.d.locks.acquire({ ...base, entityKey: key, mode: 'EXCLUSIVE_WRITE' });
      if (!res.ok) {
        await undo();
        return { ok: false, kind: res.victim ? 'deadlock' : 'locked', message: res.victim ? `${res.reason}` : `${key} is being changed by another agent (${res.heldBy.intent}); replan against its result.` };
      }
    }
    // The ledger records the contact when it lets it through (atomic per identity).
    if (recipients.length) {
      const trusted = await withTenant(ctx.tenantId, (db) => db.select({ email: schema.trustedContacts.email }).from(schema.trustedContacts));
      const known = new Set(trusted.map((t) => normalizeIdentity(t.email)));
      for (const r of recipients) {
        const relationship: Relationship = known.has(r) ? 'client' : 'prospect';
        const res = await this.d.ledger.attempt({ tenantId: ctx.tenantId, identity: r, channel: CHANNEL[ctx.tool.connectorKind] ?? 'email', runId: ctx.runId, agentId: ctx.agentId, onBehalfOf: ctx.principalUserId, relationship });
        if (!res.ok) {
          await undo();
          return { ok: false, kind: 'cooldown', message: res.message, retryAfter: res.retryAfter.toISOString() };
        }
      }
    }
    for (const rec of records) {
      if (rec.field === undefined) continue;
      const out = await this.d.reconciler.declare({ tenantId: ctx.tenantId, entityKey: `${rec.system}:${rec.id}`, field: rec.field, runId: ctx.runId, agentId: ctx.agentId, value: rec.after, riskTier: o.riskTier });
      if (out.action === 'defer' || out.action === 'escalate') {
        await undo();
        return { ok: false, kind: 'conflict', message: out.message, conflictId: out.conflictId };
      }
      if (out.action === 'proceed') handle.intents.push(out.intentId);
    }
    return { ok: true, handle };
  }

  async after(ctx: StepContext, handle: unknown): Promise<void> {
    const h = handle as Handle | undefined;
    if (!h) return;
    for (const id of h.communication) await this.d.locks.release(ctx.tenantId, id).catch((e) => this.d.log.warn({ err: e }, 'could not release a communication lock (its lease will)'));
    for (const id of h.intents) await this.d.reconciler.complete(ctx.tenantId, id).catch(() => undefined);
  }

  async endRun(tenantId: string, runId: string): Promise<void> {
    await this.d.locks.releaseAllForRun(tenantId, runId);
  }
}
