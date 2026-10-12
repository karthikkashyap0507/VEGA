import { eq } from 'drizzle-orm';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse, type AuthenticationResponseJSON, type RegistrationResponseJSON } from '@simplewebauthn/server';
import { canonicalize } from '@vega/verifier';
import { schema, withTenant, approvalByRejectToken } from '@vega/db';
import { hasCapability, type Role } from '@vega/authz';
import { applyApprovalEdits, ApprovalError, ApprovalStore, checkDelegation, isRejectToken, mayApprove, readableChars, rejectTokenHash, resolveApprover, nextRole, type DecisionPacket, type HumanDecision, type RequestRow, type Surface } from '@vega/approvals';
import type { Logger } from '@vega/shared';
import type { EvidenceClient } from '../evidence/client.js';

/**
 * THE APPROVAL SERVICE, control side — docs/module8.md §5, §7, §10. Everything a PERSON does to
 * an approval goes through here, and every rule is enforced here, not in a UI:
 *
 *   authorization at DECIDE time   own role, or an active delegation from someone who holds it;
 *                                  an assignee who lost it is refused and the request re-routed
 *   separation of duties           the requester never approves; dual approvers are distinct
 *   the packet                     a decision names the digest of what was shown; the server, not
 *                                  the client, measures latency (first look → decision) and
 *                                  whether the evidence was opened before deciding
 *   the corpus                     the decision and its telemetry row commit together
 *   the receipt                    an `approval` entry in the evidence chain, with the packet
 *   mobile                         approve needs a verified WebAuthn assertion with user
 *                                  verification (biometric); reject and revoke need nothing
 *
 * The run is then woken; the executor reads the row (the arbiter) and continues.
 */

export type ApprovalProblem = { status: number; detail: string };
export class ApprovalRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Waker {
  wake(i: { tenantId: string; runId: string; key: string; decision: string; by: string }): Promise<void>;
}

export interface Actor {
  tenantId: string;
  userId: string;
  role: Role;
}

export interface QueueItem {
  id: string;
  runId: string;
  toolId: string;
  title: string;
  riskTier: string | null;
  urgency: string;
  egress: string;
  reversibility: string;
  approverRole: string;
  approvalsRequired: number;
  approvals: number;
  assignedToMe: boolean;
  onBehalfOf: string | null;
  delegatedFrom: string | null;
  requester: string;
  requesterName: string | null;
  expiresAt: string;
  createdAt: string;
  escalationLevel: number;
  questionAskedAt: string | null;
  fallback: string;
  /** Homogeneous groups (same tool, tier, reach) are the only thing bulk actions accept. */
  group: string;
}

const toError = (e: unknown): never => {
  if (e instanceof ApprovalError) {
    const status = e.code === 'NOT_FOUND' ? 404 : e.code === 'STALE_PACKET' ? 409 : e.code === 'SEPARATION_OF_DUTIES' ? 403 : 409;
    throw new ApprovalRefused(status, e.message);
  }
  throw e;
};

const packetOf = (r: RequestRow) => r.packetJson as DecisionPacket;
export const groupKey = (r: RequestRow) => `${r.toolId}|${r.riskTier ?? '-'}|${packetOf(r).what.egress}|${r.approvalsRequired}`;

export class ApprovalService {
  readonly store: ApprovalStore;

  constructor(
    private readonly deps: {
      store?: ApprovalStore;
      waker?: Waker | undefined;
      evidence?: EvidenceClient | undefined;
      logger: Logger;
      now?: () => Date;
      /** WebAuthn relying party: the web app's origin (WEB_PUBLIC_URL). */
      webauthn?: { rpId: string; origin: string; rpName: string };
    },
  ) {
    this.store = deps.store ?? new ApprovalStore();
  }

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  // ------------------------------------------------------------------ the queue (§6.1)
  async queue(a: Actor, f: { tier?: string | undefined; toolId?: string | undefined; agentId?: string | undefined } = {}): Promise<QueueItem[]> {
    const [rows, people, delegations, names, agents] = await Promise.all([
      this.store.pending(a.tenantId),
      this.store.people(a.tenantId),
      this.store.delegations(a.tenantId, { activeAt: this.now() }),
      withTenant(a.tenantId, (db) => db.select({ id: schema.users.id, name: schema.users.displayName, email: schema.users.email }).from(schema.users)),
      withTenant(a.tenantId, (db) => db.select({ id: schema.runs.id, agentId: schema.runs.agentId }).from(schema.runs).where(eq(schema.runs.status, 'AWAITING_APPROVAL'))),
    ]);
    const me = people.find((p) => p.id === a.userId);
    if (!me) return [];
    const byId = new Map(people.map((p) => [p.id, p]));
    const nameOf = new Map(names.map((n) => [n.id, n.name ?? n.email]));
    const agentOf = new Map(agents.map((r) => [r.id, r.agentId]));
    const mine = delegations.filter((d) => d.toUser === a.userId);
    const out: QueueItem[] = [];
    for (const r of rows) {
      if (r.expiresAt <= this.now()) continue;
      if (f.tier && r.riskTier !== f.tier) continue;
      if (f.toolId && r.toolId !== f.toolId) continue;
      if (f.agentId && agentOf.get(r.runId) !== f.agentId) continue;
      const assigned = r.assignedTo === a.userId;
      const may = mayApprove(me, r.approverRole, mine, byId, this.now());
      if (!assigned && !may.ok) continue;
      if (r.approvedBy.includes(a.userId)) continue;
      if (r.separationOfDuties && r.requester === a.userId) continue;
      const p = packetOf(r);
      out.push({
        id: r.id,
        runId: r.runId,
        toolId: r.toolId,
        title: p.title,
        riskTier: r.riskTier,
        urgency: r.urgency,
        egress: p.what.egress,
        reversibility: p.what.reversibility,
        approverRole: r.approverRole,
        approvalsRequired: r.approvalsRequired,
        approvals: r.approvedBy.length,
        assignedToMe: assigned,
        onBehalfOf: may.ok ? may.onBehalfOf : null,
        delegatedFrom: r.delegatedFrom,
        requester: r.requester,
        requesterName: nameOf.get(r.requester) ?? null,
        expiresAt: r.expiresAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        escalationLevel: r.escalationLevel,
        questionAskedAt: r.questionAskedAt?.toISOString() ?? null,
        fallback: r.fallback,
        group: groupKey(r),
      });
    }
    // Urgent first, then what expires soonest.
    return out.sort((x, y) => Number(y.urgency === 'urgent') - Number(x.urgency === 'urgent') || x.expiresAt.localeCompare(y.expiresAt));
  }

  /** May this person see (not necessarily decide) this request? Its deciders, its requester, auditors. */
  private async visible(a: Actor, id: string): Promise<RequestRow> {
    const r = await this.store.get(a.tenantId, id);
    if (!r) throw new ApprovalRefused(404, 'no such approval');
    if (r.requester === a.userId || r.assignedTo === a.userId || hasCapability(a.role, 'audit.read') || hasCapability(a.role, 'approvals.decide')) return r;
    const delegated = (await this.store.delegations(a.tenantId, { activeAt: this.now() })).some((d) => d.toUser === a.userId && d.fromUser === r.assignedTo);
    if (delegated) return r;
    throw new ApprovalRefused(404, 'no such approval');
  }

  async get(a: Actor, id: string) {
    const r = await this.visible(a, id);
    const decisions = await this.store.decisions(a.tenantId, id);
    return { request: summarize(r), decisions: decisions.map((d) => ({ decision: d.decision, approverId: d.approverId, reason: d.reason, edited: d.edited, editDiff: d.editDiffJson, surface: d.surface, latencyMs: d.latencyMs, at: d.createdAt.toISOString() })) };
  }

  /** The packet, exactly as stored and hashed — and the server's record that this person saw it (§6.2). */
  async packet(a: Actor, id: string, surface: Surface = 'web') {
    const r = await this.visible(a, id);
    await this.store.recordView(a.tenantId, { requestId: id, userId: a.userId, kind: 'packet', surface, at: this.now() });
    return { id: r.id, state: r.state, packet: packetOf(r), digest: r.packetDigest, expiresAt: r.expiresAt.toISOString(), approvalsRequired: r.approvalsRequired, approvals: r.approvedBy.length };
  }

  /** "Opening the evidence is instrumented" (§6.2): each opening, with how long it stayed open. */
  async evidenceOpened(a: Actor, id: string, dwellMs: number | null, surface: Surface = 'web') {
    await this.visible(a, id);
    await this.store.recordView(a.tenantId, { requestId: id, userId: a.userId, kind: 'evidence', dwellMs: dwellMs === null ? null : Math.max(0, Math.min(dwellMs, 3_600_000)), surface, at: this.now() });
    return { recorded: true };
  }

  private async telemetry(a: Actor, r: RequestRow, surface: Surface) {
    const v = await this.store.viewsOf(a.tenantId, r.id, a.userId);
    if (!v.firstViewAt) throw new ApprovalRefused(428, 'open the decision packet before deciding: a decision is about what was shown');
    return { latencyMs: Math.max(0, this.now().getTime() - v.firstViewAt.getTime()), evidenceOpened: v.evidenceOpened, evidenceDwellMs: v.evidenceDwellMs, surface, packetChars: readableChars(packetOf(r)) };
  }

  // ------------------------------------------------------------------ deciding (§5.4, §8.1, §8.3)
  async decide(a: Actor, id: string, d: { decision: HumanDecision; reason?: string | undefined; edits?: Record<string, unknown> | undefined; packetDigest: string; surface?: Surface }, opts: { stepUp?: boolean } = {}) {
    const surface = d.surface ?? 'web';
    if (surface === 'mobile' && d.decision !== 'reject' && !opts.stepUp) throw new ApprovalRefused(401, 'approving from a phone needs device authentication (biometric)');
    const r = await this.store.get(a.tenantId, id);
    if (!r) throw new ApprovalRefused(404, 'no such approval');
    const people = await this.store.people(a.tenantId);
    const me = people.find((p) => p.id === a.userId);
    if (!me) throw new ApprovalRefused(403, 'unknown user');
    const ownRun = r.requester === a.userId;
    if (d.decision === 'reject') {
      // Stopping your own action needs no role (§6.3: the safe action is always available).
      if (!ownRun) await this.authorize(a, r, me, people);
    } else {
      await this.authorize(a, r, me, people);
      if (d.reason && d.reason.length > 2000) throw new ApprovalRefused(400, 'reason too long');
    }
    let editedArgs: Record<string, unknown> | null = null;
    let diff = null;
    if (d.decision === 'approve_with_edits') {
      if (!d.edits || !Object.keys(d.edits).length) throw new ApprovalRefused(400, 'approve with edits needs the edited fields');
      const applied = applyApprovalEdits(packetOf(r).evidence.content, d.edits);
      if (!applied.diff.length) throw new ApprovalRefused(400, 'nothing changed: approve instead');
      editedArgs = applied.args;
      diff = applied.diff;
    }
    const telemetry = await this.telemetry(a, r, surface);
    let out;
    try {
      out = await this.store.decide(a.tenantId, id, { userId: a.userId, role: me.role, decision: d.decision, reason: d.reason ?? null, packetDigest: d.packetDigest, editedArgs, editDiff: diff, telemetry, now: this.now() });
    } catch (e) {
      return toError(e);
    }
    await this.after(a.tenantId, out.request, out.decision, a.userId);
    return { request: summarize(out.request), final: out.final, decision: { id: out.decision.id, decision: out.decision.decision, latencyMs: out.decision.latencyMs, evidenceOpened: out.decision.evidenceOpened, edited: out.decision.edited, editDiff: out.decision.editDiffJson } };
  }

  /**
   * Decide-time authorization (§5.4, §10). The assignee who has since lost the authority is
   * refused AND the request is re-routed to someone who has it — never decided on stale rights.
   */
  private async authorize(a: Actor, r: RequestRow, me: { id: string; role: Role; status: string; email: string }, people: Awaited<ReturnType<ApprovalStore['people']>>) {
    const delegations = await this.store.delegations(a.tenantId, { activeAt: this.now() });
    const ok = mayApprove(me, r.approverRole, delegations.filter((x) => x.toUser === me.id), new Map(people.map((p) => [p.id, p])), this.now());
    if (!ok.ok) await this.refuseAndReroute(a, r, people, ok.reason);
  }

  private async refuseAndReroute(a: Actor, r: RequestRow, people: Awaited<ReturnType<ApprovalStore['people']>>, reason: string): Promise<never> {
    if (r.assignedTo === a.userId && r.state === 'pending') {
      const delegations = await this.store.delegations(a.tenantId, { activeAt: this.now() });
      for (let role: string | null = r.approverRole; role; role = nextRole(role)) {
        const routed = resolveApprover({ people, delegations, role, requester: r.requester, separationOfDuties: r.separationOfDuties, exclude: [a.userId], now: this.now() });
        if (routed.assignedTo) {
          await this.store.reassign(a.tenantId, r.id, { assignedTo: routed.assignedTo, delegatedFrom: routed.delegatedFrom });
          await this.event(a.tenantId, 'approval.rerouted', { requestId: r.id, runId: r.runId, from: a.userId, to: routed.assignedTo, reason });
          break;
        }
      }
    }
    throw new ApprovalRefused(403, reason);
  }

  /** The receipt (M7), the event (webhooks), and the wake-up — after the decision committed. */
  private async after(tenantId: string, r: RequestRow, d: { decision: string; approverId: string | null; latencyMs: number; evidenceOpened: boolean; evidenceDwellMs: number | null; edited: boolean; editDiffJson: unknown; surface: string; reason: string | null }, by: string) {
    await this.event(tenantId, 'approval.decided', { requestId: r.id, runId: r.runId, toolId: r.toolId, decision: d.decision, by, state: r.state, latencyMs: d.latencyMs, evidenceOpened: d.evidenceOpened, edited: d.edited, surface: d.surface, packetDigest: r.packetDigest });
    if (this.deps.evidence) {
      const packetBytes = Buffer.from(canonicalize(r.packetJson));
      const diffBytes = d.edited ? Buffer.from(canonicalize(d.editDiffJson)) : null;
      await this.deps.evidence
        .append({
          tenantId,
          kind: 'approval',
          payload: {
            request_id: r.id,
            run_id: r.runId,
            action_id: r.nodeId,
            tool: { id: r.toolId },
            decision: d.decision,
            approver: by,
            approver_role: r.approverRole,
            approvals: `${r.approvedBy.length}/${r.approvalsRequired}`,
            // What the approver was SHOWN: the canonical packet's digest (its bytes are content).
            evidence_digest: r.packetDigest,
            latency_ms: d.latencyMs,
            evidence_opened: d.evidenceOpened,
            evidence_dwell_ms: d.evidenceDwellMs,
            edited: d.edited,
            ...(diffBytes ? { edit_diff_digest: `sha256:${(await import('node:crypto')).createHash('sha256').update(diffBytes).digest('hex')}` } : {}),
            surface: d.surface,
            ...(d.reason ? { reason: d.reason } : {}),
          },
          content: [{ data: packetBytes.toString('base64'), mediaType: 'application/json', sensitivity: 'body' }, ...(diffBytes ? [{ data: diffBytes.toString('base64'), mediaType: 'application/json', sensitivity: 'body' as const }] : [])],
        })
        .catch((e) => this.deps.logger.error({ err: e, request_id: r.id, alert: true }, 'the approval receipt could not be appended to the evidence chain'));
    }
    if (r.state !== 'pending' || d.decision === 'approve' || d.decision === 'approve_with_edits') {
      await this.deps.waker?.wake({ tenantId, runId: r.runId, key: r.approvalKey, decision: d.decision, by }).catch((e) => this.deps.logger.warn({ err: e, run_id: r.runId }, 'could not wake the run; it settles at its next timer'));
    }
  }

  async question(a: Actor, id: string, text: string, surface: Surface = 'web') {
    const r = await this.visible(a, id);
    const people = await this.store.people(a.tenantId);
    const me = people.find((p) => p.id === a.userId)!;
    try {
      const u = await this.store.question(a.tenantId, id, { userId: a.userId, role: me.role, text, telemetry: await this.telemetry(a, r, surface), now: this.now() });
      await this.event(a.tenantId, 'approval.question', { requestId: id, runId: r.runId, by: a.userId, to: r.requester, text: text.slice(0, 500), expiresAt: u.expiresAt.toISOString() });
      return summarize(u);
    } catch (e) {
      return toError(e);
    }
  }

  /**
   * One-tap REJECT from a push (§6.3): the capability rejects exactly one approval, no session.
   * Recorded as the assignee's decision on the `push` surface.
   */
  async rejectWithToken(token: string) {
    if (!isRejectToken(token)) throw new ApprovalRefused(400, 'not an approval capability');
    const found = await approvalByRejectToken(rejectTokenHash(token));
    if (!found) throw new ApprovalRefused(404, 'this approval is no longer pending');
    const r = (await this.store.get(found.tenantId, found.requestId))!;
    const by = r.assignedTo ?? r.requester;
    const role = (await this.store.people(found.tenantId)).find((p) => p.id === by)?.role ?? 'MEMBER';
    try {
      const out = await this.store.decide(found.tenantId, r.id, {
        userId: by,
        role,
        decision: 'reject',
        reason: 'rejected from a notification',
        packetDigest: r.packetDigest,
        telemetry: { latencyMs: Math.max(0, this.now().getTime() - (r.notifiedAt ?? r.createdAt).getTime()), evidenceOpened: false, evidenceDwellMs: null, surface: 'push', packetChars: readableChars(packetOf(r)) },
        now: this.now(),
      });
      await this.after(found.tenantId, out.request, out.decision, by);
      return { rejected: true, title: packetOf(r).title };
    } catch (e) {
      return toError(e);
    }
  }

  /**
   * Bulk (§5.3): HOMOGENEOUS groups only — same tool, tier, reach and approval count. Bulk-approving
   * different kinds of action is how rubber-stamping starts, so it is refused, not discouraged.
   * Each item is still its own decision, with its own packet seen and its own corpus row.
   */
  async bulk(a: Actor, items: Array<{ id: string; packetDigest: string }>, decision: 'approve' | 'reject', reason?: string) {
    const rows = await Promise.all(items.map((i) => this.store.get(a.tenantId, i.id)));
    if (rows.some((r) => !r)) throw new ApprovalRefused(404, 'one of these approvals does not exist');
    const groups = new Set(rows.map((r) => groupKey(r!)));
    if (groups.size > 1) throw new ApprovalRefused(422, 'bulk actions are only for groups of the same kind of action (same tool, risk tier and reach); decide these one by one');
    if (rows.some((r) => r!.approvalsRequired > 1)) throw new ApprovalRefused(422, 'dual approvals are decided one by one');
    const out = [];
    for (const i of items) out.push(await this.decide(a, i.id, { decision, packetDigest: i.packetDigest, ...(reason ? { reason } : {}) }));
    return { decided: out.length, results: out.map((o) => ({ id: o.request.id, state: o.request.state })) };
  }

  // ------------------------------------------------------------------ delegation (§5.4, §10)
  async delegate(a: Actor, d: { toUser: string; roleScope: string | null; startsAt?: Date; endsAt: Date; reason: string | null }) {
    const people = await this.store.people(a.tenantId);
    const from = people.find((p) => p.id === a.userId);
    const to = people.find((p) => p.id === d.toUser);
    if (!from || !to) throw new ApprovalRefused(404, 'no such user');
    const startsAt = d.startsAt ?? this.now();
    const problems = checkDelegation({ from, to, roleScope: d.roleScope, startsAt, endsAt: d.endsAt });
    if (problems.length) throw new ApprovalRefused(422, problems.join('; '));
    const row = await this.store.createDelegation(a.tenantId, { fromUser: a.userId, toUser: d.toUser, roleScope: d.roleScope, startsAt, endsAt: d.endsAt, reason: d.reason });
    await this.event(a.tenantId, 'delegation.created', { id: row.id, from: a.userId, to: d.toUser, roleScope: d.roleScope, startsAt: startsAt.toISOString(), endsAt: d.endsAt.toISOString() });
    await this.deps.evidence?.append({ tenantId: a.tenantId, kind: 'admin', payload: { action: 'delegation.created', delegation_id: row.id, from: a.userId, to: d.toUser, role_scope: d.roleScope, starts_at: startsAt.toISOString(), ends_at: d.endsAt.toISOString(), reason: d.reason } }).catch(() => undefined);
    return row;
  }

  // ------------------------------------------------------------------ approving from a phone (§6.3)
  private wa() {
    if (!this.deps.webauthn) throw new ApprovalRefused(503, 'device authentication is not configured');
    return this.deps.webauthn;
  }

  async deviceRegistrationOptions(a: Actor) {
    const wa = this.wa();
    const [u] = await withTenant(a.tenantId, (db) => db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, a.userId)));
    const existing = await withTenant(a.tenantId, (db) => db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, a.userId)));
    const options = await generateRegistrationOptions({
      rpName: wa.rpName,
      rpID: wa.rpId,
      userName: u?.email ?? a.userId,
      userID: new TextEncoder().encode(a.userId),
      attestationType: 'none',
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      excludeCredentials: existing.map((c) => ({ id: c.credentialId })),
    });
    await withTenant(a.tenantId, (db) => db.insert(schema.webauthnChallenges).values({ tenantId: a.tenantId, userId: a.userId, purpose: 'register', challenge: options.challenge, expiresAt: new Date(this.now().getTime() + 5 * 60_000) }));
    return options;
  }

  async registerDevice(a: Actor, response: RegistrationResponseJSON, label: string | null) {
    const wa = this.wa();
    const challenge = await this.takeChallenge(a, 'register', null, response.response.clientDataJSON);
    const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: wa.origin, expectedRPID: wa.rpId, requireUserVerification: true }).catch((e: Error) => {
      throw new ApprovalRefused(400, `device registration failed: ${e.message}`);
    });
    if (!v.verified || !v.registrationInfo) throw new ApprovalRefused(400, 'device registration failed');
    const c = v.registrationInfo.credential;
    await withTenant(a.tenantId, (db) => db.insert(schema.webauthnCredentials).values({ tenantId: a.tenantId, userId: a.userId, credentialId: c.id, publicKey: Buffer.from(c.publicKey).toString('base64url'), counter: c.counter, transports: c.transports ?? [], label }));
    return { registered: true, credentialId: c.id };
  }

  async mobileApproveOptions(a: Actor, requestId: string) {
    const wa = this.wa();
    await this.visible(a, requestId);
    const creds = await withTenant(a.tenantId, (db) => db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.userId, a.userId)));
    if (!creds.length) throw new ApprovalRefused(428, 'register this device first: approving from a phone needs its biometric');
    const options = await generateAuthenticationOptions({ rpID: wa.rpId, userVerification: 'required', allowCredentials: creds.map((c) => ({ id: c.credentialId })) });
    await withTenant(a.tenantId, (db) => db.insert(schema.webauthnChallenges).values({ tenantId: a.tenantId, userId: a.userId, purpose: 'approve', challenge: options.challenge, requestId, expiresAt: new Date(this.now().getTime() + 2 * 60_000) }));
    return options;
  }

  /** Approve from the phone: a WebAuthn assertion WITH user verification, bound to this approval. */
  async mobileApprove(a: Actor, requestId: string, response: AuthenticationResponseJSON, d: { packetDigest: string; edits?: Record<string, unknown> }) {
    const wa = this.wa();
    const challenge = await this.takeChallenge(a, 'approve', requestId, response.response.clientDataJSON);
    const [cred] = await withTenant(a.tenantId, (db) => db.select().from(schema.webauthnCredentials).where(eq(schema.webauthnCredentials.credentialId, response.id)));
    if (!cred || cred.userId !== a.userId) throw new ApprovalRefused(401, 'unknown device');
    const v = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: wa.origin, expectedRPID: wa.rpId, requireUserVerification: true, credential: { id: cred.credentialId, publicKey: Buffer.from(cred.publicKey, 'base64url'), counter: Number(cred.counter), transports: cred.transports as never } }).catch((e: Error) => {
      throw new ApprovalRefused(401, `device authentication failed: ${e.message}`);
    });
    if (!v.verified) throw new ApprovalRefused(401, 'device authentication failed');
    await withTenant(a.tenantId, (db) => db.update(schema.webauthnCredentials).set({ counter: v.authenticationInfo.newCounter, lastUsedAt: this.now() }).where(eq(schema.webauthnCredentials.id, cred.id)));
    return this.decide(a, requestId, { decision: d.edits ? 'approve_with_edits' : 'approve', packetDigest: d.packetDigest, surface: 'mobile', ...(d.edits ? { edits: d.edits } : {}) }, { stepUp: true });
  }

  /** One use, unexpired, this user's, this purpose (and this approval). */
  private async takeChallenge(a: Actor, purpose: 'register' | 'approve', requestId: string | null, clientDataJSON: string): Promise<string> {
    let presented: string;
    try {
      presented = (JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge: string }).challenge;
    } catch {
      throw new ApprovalRefused(400, 'malformed client data');
    }
    return withTenant(a.tenantId, async (db) => {
      const [c] = await db.select().from(schema.webauthnChallenges).where(eq(schema.webauthnChallenges.challenge, presented)).for('update');
      if (!c || c.userId !== a.userId || c.purpose !== purpose || c.usedAt || c.expiresAt < this.now() || (requestId && c.requestId !== requestId)) throw new ApprovalRefused(401, 'this device challenge is not valid (used, expired, or for something else)');
      await db.update(schema.webauthnChallenges).set({ usedAt: this.now() }).where(eq(schema.webauthnChallenges.id, c.id));
      return c.challenge;
    });
  }

  private async event(tenantId: string, kind: string, payload: Record<string, unknown>) {
    await withTenant(tenantId, (db) => db.insert(schema.platformEvents).values({ tenantId, actorId: null, kind, payload }));
  }
}

export function summarize(r: RequestRow) {
  return {
    id: r.id,
    runId: r.runId,
    toolId: r.toolId,
    state: r.state,
    resolution: r.resolution,
    approverRole: r.approverRole,
    assignedTo: r.assignedTo,
    delegatedFrom: r.delegatedFrom,
    escalationLevel: r.escalationLevel,
    approvalsRequired: r.approvalsRequired,
    approvedBy: r.approvedBy,
    riskTier: r.riskTier,
    urgency: r.urgency,
    expiresAt: r.expiresAt.toISOString(),
    fallback: r.fallback,
    fallbackRole: r.fallbackRole,
    packetDigest: r.packetDigest,
    questionAskedAt: r.questionAskedAt?.toISOString() ?? null,
    edited: !!r.editDiff,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  };
}
