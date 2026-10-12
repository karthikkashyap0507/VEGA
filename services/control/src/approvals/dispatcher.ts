import { eq } from 'drizzle-orm';
import { schedApprovalBatchesDue, schedApprovalsUndispatched, schedApprovalTenants, schema, withTenant } from '@vega/db';
import { ApprovalStore, computeQuality, DEFAULT_DAILY_BUDGET, mintRejectToken, nextReviewMoment, type DecisionPacket, type RequestRow } from '@vega/approvals';
import { pushTopic } from '@vega/compensators';
import type { Logger } from '@vega/shared';

/**
 * THE APPROVAL DISPATCHER — docs/module8.md §5.3, §5.6. Attention is spent in one place, not
 * scattered across the day:
 *
 *   urgent (Critical tier, or under an hour left)   → a push now, if today's budget allows
 *   everything else                                 → the person's next REVIEW MOMENT
 *                                                     (09:00 / 13:00 / 17:00 local), one push and
 *                                                     one email digest for the whole batch
 *   budget spent                                    → it waits for the next moment, and the
 *                                                     tenant's owners are told the workflow is
 *                                                     interrupting too often — a product bug
 *
 * Pushes carry a title and a deep link only — never content (§10) — and a one-tap REJECT
 * (a capability for that one approval; stopping needs no login). Approving needs the app.
 *
 * Nightly, each approver's last 7 days are scored for rubber-stamping (T12).
 */

export interface ApprovalPush {
  topic: string;
  title: string;
  message: string;
  url: string;
  urgent: boolean;
  reject?: { url: string; token: string } | undefined;
}

export interface ApprovalNotifier {
  push(p: ApprovalPush): Promise<void>;
}

export interface DigestMailer {
  send(m: { to: string; subject: string; text: string }): Promise<void>;
}

/** ntfy (self-hosted push, PROJECT.md §9): the reject capability rides in the POST body, never the URL. */
export function ntfyApprovalNotifier(url: string, fetchImpl: typeof fetch = globalThis.fetch): ApprovalNotifier {
  return {
    async push(p) {
      const res = await fetchImpl(url.replace(/\/$/, ''), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          topic: p.topic,
          title: p.title,
          message: p.message,
          click: p.url,
          priority: p.urgent ? 5 : 3,
          tags: ['clipboard'],
          actions: [{ action: 'view', label: 'Open', url: p.url }, ...(p.reject ? [{ action: 'http', label: 'Reject', url: p.reject.url, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: p.reject.token }), clear: true }] : [])],
        }),
      });
      if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
    },
  };
}

/** Development: digests go to the log (titles and links only). */
export const logMailer = (logger: Logger): DigestMailer => ({
  async send(m) {
    logger.info({ to: m.to, subject: m.subject, lines: m.text.split('\n').length }, 'approval digest (development mailer)');
  },
});

const day = (d: Date) => d.toISOString().slice(0, 10);

export class ApprovalDispatcher {
  private timer: NodeJS.Timeout | undefined;
  private qualityTimer: NodeJS.Timeout | undefined;
  private busy = false;
  readonly store: ApprovalStore;

  constructor(
    private readonly deps: {
      store?: ApprovalStore;
      notifier?: ApprovalNotifier | undefined;
      mailer?: DigestMailer | undefined;
      pushSecret?: string | undefined;
      /** Public URLs: the web app (deep links) and the gateway (the reject capability endpoint). */
      webUrl: string;
      gatewayUrl: string;
      logger: Logger;
      now?: () => Date;
    },
  ) {
    this.store = deps.store ?? new ApprovalStore();
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async settingsOf(tenantId: string) {
    return withTenant(tenantId, async (db) => {
      const [t] = await db.select({ plan: schema.tenants.plan, settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      const [ent] = t ? await db.select({ exposed: schema.planEntitlements.exposed }).from(schema.planEntitlements).where(eq(schema.planEntitlements.plan, t.plan)) : [];
      const s = (t?.settings ?? {}) as { approvalBudget?: number; reviewHours?: number[]; utcOffsetMinutes?: number };
      const routing = (ent?.exposed as { approvalRouting?: boolean } | undefined)?.approvalRouting === true;
      // Self-serve (§14.1): simple rhythm — immediate when urgent, otherwise one daily digest.
      return { budget: s.approvalBudget ?? DEFAULT_DAILY_BUDGET, hours: s.reviewHours ?? (routing ? [9, 13, 17] : [9]), offset: s.utcOffsetMinutes ?? 0 };
    });
  }

  private async emailOf(tenantId: string, userId: string): Promise<string | null> {
    const [u] = await withTenant(tenantId, (db) => db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, userId)));
    return u?.email ?? null;
  }

  private async alertOwners(tenantId: string, kind: string, payload: Record<string, unknown>) {
    await withTenant(tenantId, (db) => db.insert(schema.platformEvents).values({ tenantId, actorId: null, kind, payload }));
    this.deps.logger.warn({ tenant_id: tenantId, kind, ...payload }, 'approval notifications: the workflow is interrupting too often (a product bug, §5.3)');
  }

  async tick(): Promise<{ notified: number; batched: number; delivered: number; deferred: number }> {
    const out = { notified: 0, batched: 0, delivered: 0, deferred: 0 };
    for (const { tenantId, requestId } of await schedApprovalsUndispatched(200)) {
      try {
        const r = await this.store.get(tenantId, requestId);
        if (r) Object.entries(await this.dispatch(tenantId, r)).forEach(([k, v]) => (out[k as keyof typeof out] += v));
      } catch (e) {
        this.deps.logger.error({ err: e, request_id: requestId }, 'could not dispatch an approval');
      }
    }
    for (const { tenantId, batchId } of await schedApprovalBatchesDue(this.now())) {
      try {
        const r = await this.deliver(tenantId, batchId);
        out.delivered += r.delivered;
        out.deferred += r.deferred;
      } catch (e) {
        this.deps.logger.error({ err: e, batch_id: batchId }, 'could not deliver an approval batch');
      }
    }
    return out;
  }

  private async dispatch(tenantId: string, r: RequestRow) {
    const out = { notified: 0, batched: 0, deferred: 0 };
    const now = this.now();
    if (!r.assignedTo) {
      await this.alertOwners(tenantId, 'approval.unassigned', { requestId: r.id, role: r.approverRole });
      await this.store.markNotified(tenantId, [r.id], now);
      return out;
    }
    const s = await this.settingsOf(tenantId);
    const urgent = r.urgency === 'urgent' || r.escalationLevel > 0;
    if (urgent) {
      const b = await this.store.takeBudget(tenantId, r.assignedTo, day(now), s.budget);
      if (b.ok) {
        await this.pushOne(tenantId, r);
        await this.store.markNotified(tenantId, [r.id], now);
        out.notified++;
        return out;
      }
      await this.alertOwners(tenantId, 'approval.notification_overflow', { userId: r.assignedTo, requestId: r.id, budget: b.budget });
      out.deferred++;
    }
    await this.store.addToBatch(tenantId, r.id, r.assignedTo, nextReviewMoment(now, s.hours, s.offset));
    out.batched++;
    return out;
  }

  private async pushOne(tenantId: string, r: RequestRow) {
    if (!this.deps.notifier || !this.deps.pushSecret) return;
    const { token, hash } = mintRejectToken(tenantId);
    await this.store.setRejectToken(tenantId, r.id, hash);
    await this.deps.notifier.push({
      topic: pushTopic(r.assignedTo!, this.deps.pushSecret),
      // Title and deep link only: never the content (§10).
      title: `Approval needed${r.riskTier ? ` · ${r.riskTier}` : ''}`,
      message: `${r.toolId} is waiting for you. Open it to read and decide; reject here if it should not happen.`,
      url: `${this.deps.webUrl.replace(/\/$/, '')}/m/approvals/${r.id}`,
      urgent: true,
      reject: { url: `${this.deps.gatewayUrl.replace(/\/$/, '')}/v1/approvals/reject`, token },
    });
  }

  private async deliver(tenantId: string, batchId: string): Promise<{ delivered: number; deferred: number }> {
    const b = await this.store.batch(tenantId, batchId);
    const now = this.now();
    if (!b) return { delivered: 0, deferred: 0 };
    if (!b.items.length) {
      await this.store.markBatchDelivered(tenantId, batchId, now);
      return { delivered: 0, deferred: 0 };
    }
    const s = await this.settingsOf(tenantId);
    const budget = await this.store.takeBudget(tenantId, b.userId, day(now), s.budget);
    if (!budget.ok) {
      await this.store.rescheduleBatch(tenantId, batchId, nextReviewMoment(now, s.hours, s.offset));
      await this.alertOwners(tenantId, 'approval.notification_overflow', { userId: b.userId, batchId, items: b.items.length, budget: budget.budget });
      return { delivered: 0, deferred: 1 };
    }
    const link = `${this.deps.webUrl.replace(/\/$/, '')}/approvals`;
    if (this.deps.notifier && this.deps.pushSecret) {
      await this.deps.notifier.push({ topic: pushTopic(b.userId, this.deps.pushSecret), title: `${b.items.length} approval${b.items.length === 1 ? '' : 's'} waiting`, message: 'Your review moment: everything waiting for you, in one place.', url: link, urgent: false });
    }
    const email = await this.emailOf(tenantId, b.userId);
    if (email && this.deps.mailer) {
      const lines = b.items.map((r) => `• ${(r.packetJson as DecisionPacket).what.reversibility} · ${r.toolId}${r.riskTier ? ` · ${r.riskTier}` : ''} — expires ${r.expiresAt.toISOString()}\n  ${link}?open=${r.id}`);
      await this.deps.mailer.send({ to: email, subject: `${b.items.length} approval${b.items.length === 1 ? '' : 's'} waiting for you`, text: `${lines.join('\n')}\n\nOpen the inbox to read and decide: ${link}` });
    }
    await this.store.markBatchDelivered(tenantId, batchId, now);
    return { delivered: b.items.length, deferred: 0 };
  }

  /** Nightly (§5.6): each approver's last 7 days → approval_quality, flags announced once. */
  async computeQuality(): Promise<number> {
    let flagged = 0;
    const since = new Date(this.now().getTime() - 7 * 86_400_000);
    const windowStart = day(since);
    for (const tenantId of await schedApprovalTenants()) {
      const decisions = await this.store.decisionsSince(tenantId, since);
      const byApprover = new Map<string, typeof decisions>();
      for (const d of decisions) if (d.approverId) byApprover.set(d.approverId, [...(byApprover.get(d.approverId) ?? []), d]);
      const before = new Map((await this.store.quality(tenantId, windowStart)).map((q) => [`${q.approverId}|${q.windowStart}`, q.flag]));
      for (const [approverId, ds] of byApprover) {
        const q = computeQuality(ds.map((d) => ({ decision: d.decision, latencyMs: d.latencyMs, evidenceOpened: d.evidenceOpened, edited: d.edited, riskTier: d.riskTier, packetChars: d.packetChars })));
        if (!q.decisions) continue;
        await this.store.saveQuality(tenantId, { approverId, windowStart, ...q });
        if (q.flag && before.get(`${approverId}|${windowStart}`) !== q.flag) {
          flagged++;
          await withTenant(tenantId, (db) => db.insert(schema.platformEvents).values({ tenantId, actorId: null, kind: 'approval.quality_flag', payload: { approverId, flag: q.flag, windowStart, decisions: q.decisions, tooFastRate: q.tooFastRate, highEvidenceOpenRate: q.highEvidenceOpenRate } }));
        }
      }
    }
    return flagged;
  }

  start(intervalMs = 30_000, qualityEveryMs = 24 * 3_600_000): void {
    this.stop();
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.tick()
        .catch((e) => this.deps.logger.error({ err: e }, 'approval dispatcher tick failed'))
        .finally(() => (this.busy = false));
    }, intervalMs);
    this.timer.unref();
    this.qualityTimer = setInterval(() => void this.computeQuality().catch((e) => this.deps.logger.error({ err: e }, 'rubber-stamp job failed')), qualityEveryMs);
    this.qualityTimer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.qualityTimer) clearInterval(this.qualityTimer);
  }
}
