import { eq } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import {
  ApprovalStore,
  durationMs,
  effectiveFallback,
  ESCALATE_AFTER,
  isUrgent,
  nextRole,
  renderPacket,
  resolveApprover,
  type Fallback,
  type RequestRow,
} from '@vega/approvals';
import type { LoadedRun } from '@vega/runs';
import type { PendingAction } from '../executor/pass.js';

/**
 * THE APPROVAL ORCHESTRATOR, execution side — docs/module8.md §3, §5.2–§5.4, §8.
 *
 * When the hook chain pauses a call for approval (M5's REQUIRE_APPROVAL / REQUIRE_DUAL_APPROVAL,
 * or the M3 gate), the run workflow asks this to OPEN an approval request: the approver resolved
 * (role → person, delegation honored, separation of duties; the account owner on self-serve
 * plans), the decision packet rendered and hashed, an expiry and a declared fallback, an
 * escalation point. The workflow then waits on the row: a person's decision (control plane) or
 * these timers SETTLE it — whichever commits first.
 *
 * Nothing here notifies anyone: the control plane's dispatcher picks up new requests and batches
 * or interrupts by urgency, within the notification budget.
 */

export interface ApprovalAudit {
  append(e: { tenantId: string; kind: string; payload: Record<string, unknown> }): Promise<void>;
}

export interface OpenedApproval {
  id: string;
  state: string;
  expiresAt: string;
  escalateAt: string | null;
}

export interface SettledApproval extends OpenedApproval {
  approvedBy: string[];
  packetDigest: string;
  tier: string | null;
  editedArgs: Record<string, unknown> | null;
  resolution: string | null;
  resolvedBy: string | null;
}

const view = (r: RequestRow): SettledApproval => ({
  id: r.id,
  state: r.state,
  expiresAt: r.expiresAt.toISOString(),
  escalateAt: r.escalateAt?.toISOString() ?? null,
  approvedBy: r.approvedBy,
  packetDigest: r.packetDigest,
  tier: r.riskTier,
  editedArgs: (r.editedArgs as Record<string, unknown> | null) ?? null,
  resolution: r.resolution,
  resolvedBy: r.resolvedBy,
});

export class ApprovalOrchestrator {
  readonly store: ApprovalStore;

  constructor(
    private readonly deps: {
      store?: ApprovalStore;
      audit?: ApprovalAudit | undefined;
      now?: () => Date;
      /** The approval window; default the agent's `escalation.expiry`. Tests shorten it. */
      windowMs?: (run: LoadedRun) => number;
    } = {},
  ) {
    this.store = deps.store ?? new ApprovalStore();
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private async tenantFacts(tenantId: string, principal: string) {
    return withTenant(tenantId, async (db) => {
      const [t] = await db.select({ plan: schema.tenants.plan }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      const [ent] = t ? await db.select({ exposed: schema.planEntitlements.exposed }).from(schema.planEntitlements).where(eq(schema.planEntitlements.plan, t.plan)) : [];
      const exposed = (ent?.exposed ?? {}) as { approvalRouting?: boolean; dualApproval?: boolean };
      const owners = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.role, 'OWNER'));
      const [p] = await db.select({ name: schema.users.displayName, email: schema.users.email }).from(schema.users).where(eq(schema.users.id, principal));
      return { routing: exposed.approvalRouting === true, dual: exposed.dualApproval === true, owner: owners[0]?.id ?? null, principalName: p?.name ?? p?.email ?? null };
    });
  }

  /** Role → a person, climbing the chain if nobody holds it (an approval is never orphaned). */
  private async route(tenantId: string, role: string, requester: string, sod: boolean, singleOwner: string | null) {
    const [people, delegations] = await Promise.all([this.store.people(tenantId), this.store.delegations(tenantId, { activeAt: this.now() })]);
    for (let r: string | null = role; r; r = nextRole(r)) {
      const routed = resolveApprover({ people, delegations, role: r, requester, separationOfDuties: sod, singleUserOwner: singleOwner, now: this.now() });
      if (routed.assignedTo) return { role: r, ...routed };
    }
    return { role, assignedTo: null, delegatedFrom: null, eligible: [] as string[] };
  }

  async open(i: { run: LoadedRun; pending: PendingAction; toolTitle: string; escalationLevel?: number; roleOverride?: string; fallbackOverride?: Fallback }): Promise<OpenedApproval> {
    const { run, pending } = i;
    const facts = await this.tenantFacts(run.tenantId, run.principalUserId);
    const policy = pending.policy;
    const single = facts.routing ? null : facts.owner;
    const sod = facts.routing && policy?.separationOfDuties === true;
    const required = facts.dual ? (pending.approvalsRequired ?? 1) : 1;
    const wantedRole = i.roleOverride ?? policy?.approverRole ?? run.spec.escalation.approverRole ?? 'APPROVER';
    const routed = await this.route(run.tenantId, wantedRole, run.principalUserId, sod, single);
    const now = this.now();
    const windowMs = this.deps.windowMs?.(run) ?? durationMs(run.spec.escalation.expiry);
    const expiresAt = new Date(now.getTime() + windowMs);
    const fb = effectiveFallback({ configured: i.fallbackOverride ?? run.spec.escalation.fallback, tier: policy?.riskTier ?? null, egress: pending.egressClass ?? 'EXTERNAL', reversibility: pending.reversibility ?? 'R3', approverRole: routed.role });
    const escalateAt = !single && nextRole(routed.role) && fb.fallback !== 'ESCALATE' ? new Date(now.getTime() + windowMs * ESCALATE_AFTER) : null;
    const tier = policy?.riskTier ?? null;
    const { packet, digest } = renderPacket({
      request: { toolId: pending.toolId ?? 'action', toolTitle: i.toolTitle, approverRole: routed.role, approvalsRequired: required, separationOfDuties: sod, expiresAt: expiresAt.toISOString(), fallback: fb.fallback, fallbackRole: fb.fallbackRole, urgency: isUrgent(tier, windowMs) ? 'urgent' : 'normal' },
      run: { id: run.id, objective: run.objective.objective, trigger: run.trigger, requestedBy: run.principalUserId, requestedByName: facts.principalName, startedAt: now.toISOString() },
      action: { args: pending.args ?? {}, reversibility: pending.reversibility ?? 'R3', egress: pending.egressClass ?? 'EXTERNAL', holdWindowMs: policy?.holdWindowMs ?? null, effect: pending.effect ?? null },
      provenance: { argTaint: pending.argTaint ?? 'TRUSTED', argTaints: pending.argTaints ?? [] },
      ...(pending.verification ? { verification: pending.verification } : {}),
      risk: policy ? { score: policy.riskScore ?? null, tier, factors: (policy.inputs?.factors as Record<string, number> | undefined) ?? null } : null,
      policy: { decision: policy?.decision ?? 'REQUIRE_APPROVAL', decidedBy: policy?.inputs?.decidedBy ?? null, reason: pending.reason ?? policy?.reason ?? null, citation: policy?.chain?.find((s) => s.citation)?.citation ?? null, chain: policy?.chain ?? [] },
    });
    const row = await this.store.open(run.tenantId, {
      runId: run.id,
      nodeId: pending.nodeRowId!,
      actionId: pending.actionId ?? null,
      approvalKey: pending.key!,
      toolId: pending.toolId ?? 'action',
      requester: run.principalUserId,
      approverRole: routed.role,
      assignedTo: routed.assignedTo,
      delegatedFrom: routed.delegatedFrom,
      escalateAt,
      escalationLevel: i.escalationLevel ?? 0,
      packet,
      packetDigest: digest,
      riskTier: tier,
      urgency: isUrgent(tier, windowMs) ? 'urgent' : 'normal',
      approvalsRequired: required,
      separationOfDuties: sod,
      expiresAt,
      fallback: fb.fallback,
      fallbackRole: fb.fallbackRole,
      rejectTokenHash: null,
      createdAt: now,
    });
    await this.event(run.tenantId, 'approval.requested', { runId: run.id, requestId: row.id, toolId: row.toolId, approverRole: row.approverRole, assignedTo: row.assignedTo, delegatedFrom: row.delegatedFrom, expiresAt: row.expiresAt.toISOString(), fallback: row.fallback, riskTier: tier, urgency: row.urgency, packetDigest: row.packetDigest, ...(fb.note ? { fallbackNote: fb.note } : {}) });
    return view(row);
  }

  /**
   * The timers (§5.4, §8.2): past the escalation point → the next person up; past the expiry →
   * the declared fallback. ESCALATE as a fallback supersedes the request with a fresh one for the
   * next role (whose own fallback is AUTO_REJECT: an escalation chain ends).
   */
  async settle(tenantId: string, id: string, run: LoadedRun, pending: PendingAction, toolTitle: string): Promise<SettledApproval> {
    const before = await this.store.get(tenantId, id);
    const row = await this.store.settle(tenantId, id, this.now(), async (r) => {
      const role = nextRole(r.approverRole);
      if (!role) return null;
      const routed = await this.route(tenantId, role, r.requester, r.separationOfDuties, null);
      return routed.assignedTo ? { role: routed.role, assignedTo: routed.assignedTo } : null;
    });
    if (before?.state === 'pending' && row.state === 'pending' && row.escalationLevel > before.escalationLevel) {
      await this.event(tenantId, 'approval.escalated', { runId: row.runId, requestId: row.id, toolId: row.toolId, from: before.approverRole, to: row.approverRole, assignedTo: row.assignedTo });
    }
    if (before?.state === 'pending' && row.state !== 'pending' && row.resolution?.startsWith('fallback:')) {
      await this.event(tenantId, 'approval.expired', { runId: row.runId, requestId: row.id, toolId: row.toolId, fallback: row.fallback, outcome: row.state });
      await this.deps.audit?.append({ tenantId, kind: 'approval', payload: { run_id: row.runId, action_id: row.nodeId, request_id: row.id, tool: { id: row.toolId }, decision: row.state === 'approved' ? 'AUTO_APPROVED' : row.state === 'escalated' ? 'ESCALATED' : 'EXPIRED', fallback: row.fallback, packet_digest: row.packetDigest, expired_at: row.resolvedAt?.toISOString() ?? null } }).catch(() => undefined);
      if (row.state === 'escalated' && row.fallbackRole) {
        const next = await this.open({ run, pending, toolTitle, escalationLevel: row.escalationLevel + 1, roleOverride: row.fallbackRole, fallbackOverride: 'AUTO_REJECT' });
        await this.event(tenantId, 'approval.escalated', { runId: row.runId, requestId: next.id, supersedes: row.id, toolId: row.toolId, from: row.approverRole, to: row.fallbackRole });
        return { ...(await this.lookup(tenantId, next.id)) };
      }
    }
    return view(row);
  }

  async lookup(tenantId: string, id: string): Promise<SettledApproval> {
    const r = await this.store.get(tenantId, id);
    if (!r) throw new Error(`approval request ${id} not found`);
    return view(r);
  }

  async editedArgs(tenantId: string, requestId: string): Promise<Record<string, unknown> | null> {
    return ((await this.store.get(tenantId, requestId))?.editedArgs as Record<string, unknown> | null) ?? null;
  }

  async cancel(tenantId: string, runId: string, reason: string): Promise<void> {
    await this.store.cancelPending(tenantId, runId, reason);
  }

  private async event(tenantId: string, kind: string, payload: Record<string, unknown>) {
    await withTenant(tenantId, (db) => db.insert(schema.platformEvents).values({ tenantId, actorId: null, kind, payload }));
  }
}
