import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import { SYSTEM_TENANT } from '@vega/idp';
import { ApprovalStore, packetDigest, renderPacket, type PacketInput } from '@vega/approvals';
import { PRINCIPAL_HEADER } from '../src/app.js';
import { ApprovalDispatcher, type ApprovalPush } from '../src/approvals/dispatcher.js';
import { ApprovalService } from '../src/approvals/service.js';
import { createHarness, problemOf, type Harness } from './harness.js';

/**
 * THE APPROVAL API (docs/module8.md §5, §7, §10, §11) against real Postgres and OpenFGA, through
 * the real HTTP surface with signed principal assertions. Blocking suites: separation of duties,
 * decide-time authorization, telemetry completeness, packet integrity; plus the notification
 * budget, the one-tap push reject, homogeneous bulk, delegation, approving on a phone with its
 * biometric (a software authenticator), rubber-stamp detection and the Action Center.
 */

vi.setConfig({ testTimeout: 30_000 });
process.env['LOCAL_KEK_BASE64'] ??= randomBytes(32).toString('base64');

const owner = new pg.Pool({ connectionString: process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega', max: 3 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await owner.query<T>(sql, params)).rows;
const store = new ApprovalStore();
const woken: Array<{ runId: string; decision: string }> = [];
const pushes: ApprovalPush[] = [];
let clock = Date.now();
const now = () => new Date(clock);
const ORIGIN = 'https://app.vega.test';
let h: Harness;
let svc: ApprovalService;
let dispatcher: ApprovalDispatcher;
let T: Awaited<ReturnType<Harness['tenant']>>;
const U: Record<'requester' | 'approver' | 'approver2' | 'admin' | 'member' | 'auditor', string> = { requester: '', approver: '', approver2: '', admin: '', member: '', auditor: '' };
let agentId = '';

beforeAll(async () => {
  svc = new ApprovalService({ store, logger: undefined as never, now, waker: { wake: async (w) => void woken.push({ runId: w.runId, decision: w.decision }) }, webauthn: { rpId: 'app.vega.test', origin: ORIGIN, rpName: 'Test' } });
  h = await createHarness({ approvals: svc });
  (svc as unknown as { deps: { logger: unknown } }).deps.logger = h.deps.logger;
  dispatcher = new ApprovalDispatcher({ store, notifier: { push: async (p) => void pushes.push(p) }, mailer: { send: async () => undefined }, pushSecret: 'push-secret', webUrl: 'https://app.vega.test', gatewayUrl: 'https://api.vega.test', logger: h.deps.logger, now });
  T = await h.tenant('enterprise');
  const mk = async (role: string, name: string) => (await q<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [T.tenantId, `${name}-${T.tenantId.slice(0, 6)}@example.com`, name, role]))[0]!.id;
  U.requester = await mk('MEMBER', 'requester');
  U.approver = await mk('APPROVER', 'approver');
  U.approver2 = await mk('APPROVER', 'approver2');
  U.admin = await mk('ADMIN', 'admin');
  U.member = await mk('MEMBER', 'member');
  U.auditor = await mk('COMPLIANCE_OFFICER', 'auditor');
  agentId = (await q<{ id: string }>(`INSERT INTO agents (tenant_id, workspace_id, name, owner_user_id, idp_machine_id, status) VALUES ($1, $2, 'a', $3, 'm', 'active') RETURNING id`, [T.tenantId, T.workspaceId, T.userId]))[0]!.id;
}, 60_000);

afterAll(async () => {
  await h?.close();
  await owner.end();
});

const as = (who: keyof typeof U) => h.as(T.tenantId, U[who]);

/** A run paused on an approval, as the executor's orchestrator opens it. */
async function request(over: { tool?: string; tier?: string; egress?: string; required?: number; sod?: boolean; role?: string; assignedTo?: string | null; expiresInMs?: number; urgency?: 'normal' | 'urgent'; args?: Record<string, unknown> } = {}) {
  const runId = (await q<{ id: string }>(`INSERT INTO runs (tenant_id, workspace_id, agent_id, principal_user_id, trigger, objective_json, status) VALUES ($1, $2, $3, $4, 'chat', '{"objective":"Reply to Acme"}', 'AWAITING_APPROVAL') RETURNING id`, [T.tenantId, T.workspaceId, agentId, U.requester]))[0]!.id;
  const nodeId = (await q<{ id: string }>(`INSERT INTO task_nodes (tenant_id, run_id, program_version, step_index, call_seq, kind, tool_id, status) VALUES ($1, $2, 1, 1, 1, 'TOOL_CALL', $3, 'approving') RETURNING id`, [T.tenantId, runId, over.tool ?? 'gmail.send']))[0]!.id;
  const expiresAt = new Date(clock + (over.expiresInMs ?? 4 * 3_600_000));
  const input: PacketInput = {
    request: { toolId: over.tool ?? 'gmail.send', toolTitle: 'Send email', approverRole: over.role ?? 'APPROVER', approvalsRequired: over.required ?? 1, separationOfDuties: over.sod ?? false, expiresAt: expiresAt.toISOString(), fallback: 'AUTO_REJECT', fallbackRole: null, urgency: over.urgency ?? 'normal' },
    run: { id: runId, objective: 'Reply to Acme', trigger: 'chat', requestedBy: U.requester, requestedByName: 'requester', startedAt: new Date(clock).toISOString() },
    action: { args: over.args ?? { to: ['peter@acme.example'], subject: 'Terms', body: 'Revised terms. Price is $10.' }, reversibility: 'R2', egress: over.egress ?? 'EXTERNAL', holdWindowMs: null, effect: { summary: 'Send 1 email to peter@acme.example (external)', externalRecipients: ['peter@acme.example'], recordsAffected: [], fidelity: 'DERIVED' } },
    provenance: { argTaint: 'UNTRUSTED', argTaints: [{ path: 'body', taint: 'UNTRUSTED', dataTaint: 'UNTRUSTED', sourceIds: ['gmail:msg_44'] }] },
    risk: { score: 68, tier: over.tier ?? 'HIGH' },
    policy: { decision: 'REQUIRE_APPROVAL', decidedBy: 'external-comms', reason: 'External communications are supervised', citation: 'FINRA 2210', chain: [] },
  };
  const { packet, digest } = renderPacket(input);
  const row = await store.open(T.tenantId, { runId, nodeId, actionId: null, approvalKey: `v1:1:${randomUUID()}`, toolId: input.request.toolId, requester: U.requester, approverRole: input.request.approverRole, assignedTo: over.assignedTo === undefined ? U.approver : over.assignedTo, delegatedFrom: null, escalateAt: null, packet, packetDigest: digest, riskTier: over.tier ?? 'HIGH', urgency: over.urgency ?? 'normal', approvalsRequired: over.required ?? 1, separationOfDuties: over.sod ?? false, expiresAt, fallback: 'AUTO_REJECT', fallbackRole: null, rejectTokenHash: null, createdAt: new Date(clock) });
  return row;
}

describe('packet integrity (§10)', () => {
  it('the stored packet re-hashes to its digest; a decision on another digest is refused', async () => {
    const r = await request();
    const p = await as('approver').approvals.packet.mutate({ id: r.id });
    expect(packetDigest(p.packet)).toBe(p.digest);
    const stale = await problemOf(as('approver').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: `sha256:${'0'.repeat(64)}` }));
    expect(stale.status).toBe(409);
  });
  it('a decision without having opened the packet is refused (latency is measured by the server)', async () => {
    const r = await request();
    expect((await problemOf(as('approver').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest }))).status).toBe(428);
  });
});

describe('telemetry completeness (§5.5 — BLOCKING): every decision writes a full corpus row', () => {
  it('latency from first look, evidence opened and dwell, surface, digest, the packet size, and the risk tier', async () => {
    const r = await request();
    await as('approver').approvals.packet.mutate({ id: r.id });
    clock += 3_000;
    await as('approver').approvals.evidence.mutate({ id: r.id, dwellMs: 2_500 });
    clock += 5_400;
    const out = await as('approver').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest });
    expect(out.final).toBe(true);
    const [d] = await q<Record<string, unknown>>(`SELECT * FROM approval_decisions WHERE request_id = $1`, [r.id]);
    expect(d).toMatchObject({ decision: 'approve', approver_id: U.approver, approver_role: 'APPROVER', latency_ms: 8_400, evidence_opened: true, evidence_dwell_ms: 2_500, surface: 'web', packet_digest: r.packetDigest, risk_tier: 'HIGH', edited: false });
    expect(d!['packet_chars']).toBeGreaterThan(100);
    expect(woken.at(-1)).toMatchObject({ runId: r.runId, decision: 'approve' });
    // Never rewritten, never deleted: the corpus is the moat.
    await expect(q(`UPDATE approval_decisions SET latency_ms = 1 WHERE request_id = $1`, [r.id])).rejects.toThrow(/override corpus/);
    await expect(q(`DELETE FROM approval_decisions WHERE request_id = $1`, [r.id])).rejects.toThrow(/override corpus/);
  });
  it('approve with edits: the diff is structural — path, before, after — and the edited arguments are kept', async () => {
    const r = await request();
    await as('approver').approvals.packet.mutate({ id: r.id });
    await as('approver').approvals.decide.mutate({ id: r.id, decision: 'approve_with_edits', packetDigest: r.packetDigest, edits: { body: 'Revised terms.' } });
    const [d] = await q<{ edited: boolean; edit_diff_json: unknown }>(`SELECT edited, edit_diff_json FROM approval_decisions WHERE request_id = $1`, [r.id]);
    expect(d).toEqual({ edited: true, edit_diff_json: [{ path: 'body', op: 'changed', before: 'Revised terms. Price is $10.', after: 'Revised terms.' }] });
    const [row] = await q<{ edited_args: Record<string, unknown> }>(`SELECT edited_args FROM approval_requests WHERE id = $1`, [r.id]);
    expect(row!.edited_args).toMatchObject({ body: 'Revised terms.', to: ['peter@acme.example'] });
  });
  it('no decided request exists without its corpus row', async () => {
    const missing = await q(`SELECT r.id FROM approval_requests r WHERE r.tenant_id = $1 AND r.resolution = 'decided' AND NOT EXISTS (SELECT 1 FROM approval_decisions d WHERE d.request_id = r.id AND d.decision IN ('approve','approve_with_edits','reject'))`, [T.tenantId]);
    expect(missing).toEqual([]);
  });
});

describe('separation of duties and dual approval (§5.4 — BLOCKING)', () => {
  it('the requester cannot approve; two DISTINCT approvers are needed; the same one twice is refused', async () => {
    const r = await request({ required: 2, sod: true, role: 'APPROVER' });
    // The requester is a MEMBER here; even made an ADMIN, separation of duties holds.
    await q(`UPDATE users SET role = 'ADMIN' WHERE id = $1`, [U.requester]);
    try {
      await h.as(T.tenantId, U.requester).approvals.packet.mutate({ id: r.id });
      expect((await problemOf(h.as(T.tenantId, U.requester).approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest }))).status).toBe(403);
    } finally {
      await q(`UPDATE users SET role = 'MEMBER' WHERE id = $1`, [U.requester]);
    }
    await as('approver').approvals.packet.mutate({ id: r.id });
    const first = await as('approver').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest });
    expect(first).toMatchObject({ final: false, request: { state: 'pending', approvedBy: [U.approver] } });
    expect((await problemOf(as('approver').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest }))).status).toBe(409);
    await as('approver2').approvals.packet.mutate({ id: r.id });
    const second = await as('approver2').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest });
    expect(second).toMatchObject({ final: true, request: { state: 'approved', approvedBy: [U.approver, U.approver2] } });
  });
  it('the requester can always STOP their own action (reject needs no role)', async () => {
    const r = await request();
    await h.as(T.tenantId, U.requester).approvals.packet.mutate({ id: r.id });
    const out = await h.as(T.tenantId, U.requester).approvals.decide.mutate({ id: r.id, decision: 'reject', packetDigest: r.packetDigest, reason: 'changed my mind' });
    expect(out.request.state).toBe('rejected');
  });
});

describe('decide-time authorization (§5.4 — BLOCKING)', () => {
  it('an assignee whose role was revoked is refused, and the request is re-routed to someone who may decide', async () => {
    const r = await request();
    await as('approver').approvals.packet.mutate({ id: r.id });
    await q(`UPDATE users SET role = 'MEMBER' WHERE id = $1`, [U.approver]);
    try {
      const p = await problemOf(as('approver').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest }));
      expect(p.status).toBe(403);
      const [row] = await q<{ assigned_to: string; state: string }>(`SELECT assigned_to, state FROM approval_requests WHERE id = $1`, [r.id]);
      expect(row).toEqual({ assigned_to: U.approver2, state: 'pending' });
      expect(await q(`SELECT 1 FROM platform_events WHERE kind = 'approval.rerouted' AND payload->>'requestId' = $1`, [r.id])).toHaveLength(1);
    } finally {
      await q(`UPDATE users SET role = 'APPROVER' WHERE id = $1`, [U.approver]);
    }
  });
  it('decisions on expired or superseded requests are rejected', async () => {
    const r = await request({ expiresInMs: 1_000 });
    await as('approver').approvals.packet.mutate({ id: r.id });
    clock += 2_000;
    expect((await problemOf(as('approver').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest }))).status).toBe(409);
  });
});

describe('ask without deciding (§7)', () => {
  it('records the question in the corpus and pauses the expiry — once', async () => {
    const r = await request({ expiresInMs: 3_600_000 });
    await as('approver').approvals.packet.mutate({ id: r.id });
    const after = await as('approver').approvals.question.mutate({ id: r.id, text: 'Did legal see the new price?' });
    expect(Date.parse(after.expiresAt) - r.expiresAt.getTime()).toBe(3_600_000);
    expect((await problemOf(as('approver').approvals.question.mutate({ id: r.id, text: 'And again?' }))).status).toBe(409);
    expect(await q(`SELECT 1 FROM approval_decisions WHERE request_id = $1 AND decision = 'question'`, [r.id])).toHaveLength(1);
  });
});

describe('homogeneous bulk only (§5.3)', () => {
  it('a group of the same kind can be decided at once; a mixed group is refused', async () => {
    const a = await request({ tier: 'MEDIUM' });
    const b = await request({ tier: 'MEDIUM' });
    const c = await request({ tier: 'HIGH' });
    for (const r of [a, b, c]) await as('approver').approvals.packet.mutate({ id: r.id });
    expect((await problemOf(as('approver').approvals.bulk.mutate({ items: [a, c].map((r) => ({ id: r.id, packetDigest: r.packetDigest })), decision: 'approve' }))).status).toBe(422);
    const ok = await as('approver').approvals.bulk.mutate({ items: [a, b].map((r) => ({ id: r.id, packetDigest: r.packetDigest })), decision: 'approve' });
    expect(ok.decided).toBe(2);
    expect(await q(`SELECT 1 FROM approval_decisions WHERE request_id = ANY($1::uuid[])`, [[a.id, b.id]])).toHaveLength(2);
  });
});

describe('delegation (§5.4, §10)', () => {
  it('a delegate decides on behalf while it lasts; never beyond what the delegator holds; ended, it stops', async () => {
    expect((await problemOf(as('member').delegations.create.mutate({ toUser: U.approver, endsAt: new Date(clock + 86_400_000).toISOString() }))).status).toBe(422);
    const d = await as('approver').delegations.create.mutate({ toUser: U.member, endsAt: new Date(Date.now() + 86_400_000).toISOString(), reason: 'out of office' });
    const r = await request();
    const queue = await as('member').approvals.list.query();
    expect(queue.items.find((i) => i.id === r.id)).toMatchObject({ onBehalfOf: U.approver });
    await as('member').approvals.packet.mutate({ id: r.id });
    await as('member').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest });
    await as('approver').delegations.revoke.mutate({ id: d.id });
    const r2 = await request();
    await as('member').approvals.packet.mutate({ id: r2.id }).catch(() => undefined);
    expect((await problemOf(as('member').approvals.decide.mutate({ id: r2.id, decision: 'approve', packetDigest: r2.packetDigest }))).status).toBe(403);
  });
});

describe('notifications: urgency, batching, the budget, the one-tap reject (§5.3, §6.3, §10)', () => {
  it('urgent ones push now (title and link only, a Reject capability), the rest batch; the budget holds and overflow is flagged', async () => {
    await q(`UPDATE tenants SET settings = settings || '{"approvalBudget": 2}' WHERE id = $1`, [T.tenantId]);
    const assignee = U.admin;
    const urgent = await Promise.all([1, 2, 3].map(() => request({ urgency: 'urgent', assignedTo: assignee })));
    const normal = await request({ assignedTo: assignee });
    pushes.length = 0;
    await dispatcher.tick();
    const ours = new Set([...urgent, normal].map((r) => r.id));
    const mine = pushes.filter((p) => p.reject && ours.has(p.url.split('/').pop()!)); // the dispatcher serves every tenant
    expect(mine).toHaveLength(2); // the third urgent one hit the budget
    for (const p of mine) {
      expect(p.title).toMatch(/^Approval needed/);
      expect(JSON.stringify(p)).not.toMatch(/peter@acme|Revised terms|Price/); // never content in a push
      expect(p.url).toMatch(/\/m\/approvals\//);
    }
    const [budget] = await q<{ sent: number; overflow: number }>(`SELECT sent, overflow FROM notification_budget WHERE tenant_id = $1 AND user_id = $2`, [T.tenantId, assignee]);
    expect(budget).toEqual({ sent: 2, overflow: 1 });
    expect(await q(`SELECT 1 FROM platform_events WHERE tenant_id = $1 AND kind = 'approval.notification_overflow'`, [T.tenantId])).not.toHaveLength(0);
    const batched = await q<{ id: string }>(`SELECT id FROM approval_requests WHERE id = ANY($1::uuid[]) AND batch_id IS NOT NULL`, [[urgent[2]!.id, normal.id]]);
    expect(batched).toHaveLength(2);

    // The phone: Reject, with no session, from the capability alone.
    const token = (JSON.parse(JSON.stringify(mine[0]!.reject)) as { token: string }).token;
    const rej = h.raw({ [PRINCIPAL_HEADER]: await h.issuer.mint({ tenantId: SYSTEM_TENANT, userId: 'system:approval_reject', system: 'approval_reject' }) });
    expect(await rej.approvals.rejectWithToken.mutate({ token })).toMatchObject({ rejected: true });
    const [d] = await q<{ decision: string; surface: string; approver_id: string }>(`SELECT d.decision, d.surface, d.approver_id FROM approval_decisions d JOIN approval_requests r ON r.id = d.request_id WHERE r.reject_token_hash = $1`, [createHash('sha256').update(token).digest('hex')]);
    expect(d).toEqual({ decision: 'reject', surface: 'push', approver_id: assignee });
    expect((await problemOf(rej.approvals.rejectWithToken.mutate({ token }))).status).toBe(404); // one use
  });
});

// ------------------------------------------------------------------ a software authenticator (P-256)
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = randomBytes(16);
  const rpIdHash = createHash('sha256').update('app.vega.test').digest();
  let counter = 0;
  const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, isoBase64URL.toBuffer(jwk.x!)], [-3, isoBase64URL.toBuffer(jwk.y!)]]));
  const flags = (uv: boolean, at = false) => Buffer.from([0x01 | (uv ? 0x04 : 0) | (at ? 0x40 : 0)]);
  const count = () => Buffer.from([(counter >> 24) & 255, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255]);
  const clientData = (type: string, challenge: string) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
  return {
    register(challenge: string) {
      const authData = Buffer.concat([rpIdHash, flags(true, true), count(), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, Buffer.from(cose)]);
      const att = isoCBOR.encode(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]) as Parameters<typeof isoCBOR.encode>[0]);
      const id = isoBase64URL.fromBuffer(credId);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: isoBase64URL.fromBuffer(clientData('webauthn.create', challenge)), attestationObject: isoBase64URL.fromBuffer(att), transports: ['internal'] } };
    },
    assert(challenge: string, uv = true) {
      counter++;
      const authData = Buffer.concat([rpIdHash, flags(uv), count()]);
      const cd = clientData('webauthn.get', challenge);
      const sig = createSign('SHA256').update(Buffer.concat([authData, createHash('sha256').update(cd).digest()])).sign(privateKey);
      const id = isoBase64URL.fromBuffer(credId);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: isoBase64URL.fromBuffer(cd), authenticatorData: isoBase64URL.fromBuffer(authData), signature: isoBase64URL.fromBuffer(sig) } };
    },
  };
}

describe('approving from a phone needs its biometric (§6.3 — asymmetric authentication)', () => {
  it('claiming the mobile surface without device authentication is refused; reject from the phone needs nothing', async () => {
    const r = await request();
    await as('approver').approvals.packet.mutate({ id: r.id, surface: 'mobile' });
    expect((await problemOf(as('approver').approvals.decide.mutate({ id: r.id, decision: 'approve', packetDigest: r.packetDigest, surface: 'mobile' }))).status).toBe(401);
    const out = await as('approver').approvals.decide.mutate({ id: r.id, decision: 'reject', packetDigest: r.packetDigest, surface: 'mobile' });
    expect(out.request.state).toBe('rejected');
  });
  it('register the phone, then approve with a user-verified assertion bound to this approval; replay and no-UV are refused', async () => {
    const dev = authenticator();
    const reg = await as('approver2').approvals.device.registerOptions.mutate();
    expect(reg.authenticatorSelection?.userVerification).toBe('required');
    expect(await as('approver2').approvals.device.register.mutate({ response: dev.register(reg.challenge), label: 'phone' })).toMatchObject({ registered: true });

    const r = await request();
    await as('approver2').approvals.packet.mutate({ id: r.id, surface: 'mobile' });
    // Without user verification (a tap, no biometric): refused.
    const o1 = await as('approver2').approvals.device.approveOptions.mutate({ id: r.id });
    expect((await problemOf(as('approver2').approvals.device.approve.mutate({ id: r.id, response: dev.assert(o1.challenge, false), packetDigest: r.packetDigest }))).status).toBe(401);
    // With it: approved, on the mobile surface.
    const o2 = await as('approver2').approvals.device.approveOptions.mutate({ id: r.id });
    const assertion = dev.assert(o2.challenge);
    const out = await as('approver2').approvals.device.approve.mutate({ id: r.id, response: assertion, packetDigest: r.packetDigest });
    expect(out.request.state).toBe('approved');
    expect(await q(`SELECT surface FROM approval_decisions WHERE request_id = $1`, [r.id])).toEqual([{ surface: 'mobile' }]);
    // The same assertion again: the challenge is spent.
    const r2 = await request();
    expect((await problemOf(as('approver2').approvals.device.approve.mutate({ id: r2.id, response: assertion, packetDigest: r2.packetDigest }))).status).toBe(401);
  });
});

describe('rubber-stamp detection (T12 — BLOCKING on synthetic approver behavior)', () => {
  it('an approver clicking through faster than the packets can be read is flagged, nightly, for compliance', async () => {
    const fast = await request();
    for (let i = 0; i < 12; i++) {
      await q(
        `INSERT INTO approval_decisions (tenant_id, request_id, run_id, tool_id, approver_id, approver_role, decision, latency_ms, evidence_opened, surface, packet_digest, packet_chars, risk_tier, created_at)
         VALUES ($1, $2, $3, 'gmail.send', $4, 'ADMIN', 'approve', $5, false, 'web', 'sha256:x', 400, 'HIGH', now() - interval '1 day')`,
        [T.tenantId, fast.id, fast.runId, U.admin, i < 4 ? 900 : 15_000],
      );
    }
    expect(await dispatcher.computeQuality()).toBeGreaterThan(0);
    const rows = await h.as(T.tenantId, U.auditor).approvalQuality.list.query({ days: 30 });
    const admin = rows.find((r) => r.approverId === U.admin)!;
    expect(admin.flag).toBe('IMPLAUSIBLE_SPEED');
    expect(admin.decisions).toBeGreaterThanOrEqual(12); // + the reject they made from the push above
    expect(await q(`SELECT 1 FROM platform_events WHERE tenant_id = $1 AND kind = 'approval.quality_flag'`, [T.tenantId])).not.toHaveLength(0);
    // A person sees their own numbers; not someone else's.
    expect((await as('member').approvalQuality.list.query({ days: 30 })).some((r) => r.approverId === U.admin)).toBe(false);
  });
});

describe('the Action Center (§6.4)', () => {
  it('brief, tasks, security, usage, autonomy answer from live data', async () => {
    const r = await request({ urgency: 'urgent', expiresInMs: 60_000 }); // urgent and soonest: first in the brief
    const brief = await as('approver').actionCenter.brief.query();
    expect(brief.decisionsAwaiting.items.some((i) => i.id === r.id)).toBe(true);
    const tasks = await h.as(T.tenantId, T.userId).actionCenter.tasks.query();
    expect((tasks.groups['AWAITING_APPROVAL'] as Array<{ id: string }>).some((t) => t.id === r.runId)).toBe(true);
    const sec = await h.as(T.tenantId, U.auditor).actionCenter.security.query({ days: 14 });
    expect(sec.some((e) => e.kind === 'approval.quality_flag')).toBe(true);
    expect((await problemOf(as('member').actionCenter.security.query({ days: 14 }))).status).toBe(403);
    const usage = await h.as(T.tenantId, T.userId).actionCenter.usage.query({ days: 30 });
    expect(usage.runs).toBeGreaterThan(0);
    const autonomy = await h.as(T.tenantId, T.userId).actionCenter.autonomy.query();
    expect(autonomy.find((a) => a.agentId === agentId)).toMatchObject({ tier: 'SHADOW', promotion: { eligible: null } });
  });
});
