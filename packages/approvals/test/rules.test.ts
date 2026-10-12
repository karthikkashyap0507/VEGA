import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalize, digestOf } from '@vega/verifier';
import { applyApprovalEdits, checkDelegation, computeQuality, effectiveFallback, isUrgent, mayApprove, mintRejectToken, nextReviewMoment, nextRole, packetDigest, plausibleReadMs, rejectTokenHash, renderPacket, resolveApprover, structuralDiff, type DelegationRow, type PacketInput, type Person } from '../src/index.js';

const input = (over: Partial<PacketInput['action']> = {}): PacketInput => ({
  request: { toolId: 'gmail.send', toolTitle: 'Send email', approverRole: 'APPROVER', approvalsRequired: 1, separationOfDuties: false, expiresAt: '2026-10-12T14:02:00.000Z', fallback: 'AUTO_REJECT', fallbackRole: null, urgency: 'normal' },
  run: { id: 'run-1', objective: 'Respond to Acme', trigger: 'chat', requestedBy: 'u1', requestedByName: 'Ana', startedAt: '2026-10-12T10:02:00.000Z' },
  action: { args: { to: ['peter@acme.example'], subject: 'Terms', body: 'Revised terms attached.' }, reversibility: 'R2', egress: 'EXTERNAL', holdWindowMs: 900_000, effect: { summary: 'Send 1 email to peter@acme.example (external)', externalRecipients: ['peter@acme.example'], recordsAffected: [], fidelity: 'DERIVED' }, ...over },
  provenance: { argTaint: 'UNTRUSTED', argTaints: [{ path: 'body', taint: 'UNTRUSTED', dataTaint: 'UNTRUSTED', sourceIds: ['gmail:msg_44'] }, { path: 'to[0]', taint: 'TRUSTED', dataTaint: 'TRUSTED', sourceIds: ['contact:peter'] }] },
  risk: { score: 68, tier: 'HIGH', factors: { exposure: 60 } },
  policy: { decision: 'REQUIRE_APPROVAL', decidedBy: 'external-comms', reason: 'External communications are supervised', citation: 'FINRA 2210', chain: [{ step: 'policy', detail: 'matched', id: 'external-comms', version: 7, citation: 'FINRA 2210' }] },
});

describe('the decision packet (§5.1, §9 — BLOCKING: identical hash across renders)', () => {
  it('the same inputs render the same bytes and digest, every time', () => {
    const a = renderPacket(input());
    const b = renderPacket(JSON.parse(JSON.stringify(input())) as PacketInput);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toBe(digestOf(canonicalize(a.packet)));
    expect(packetDigest(JSON.parse(JSON.stringify(a.packet)))).toBe(a.digest); // what a reader of the receipt recomputes
  });
  it('key order and array order of the inputs do not change it (property)', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(['a@x.example', 'b@x.example', 'c@x.example'], { minLength: 3, maxLength: 3 }), (recipients) => {
        const i = input({ effect: { summary: 's', externalRecipients: recipients, recordsAffected: [], fidelity: 'DERIVED' } });
        return renderPacket(i).digest === renderPacket(input({ effect: { summary: 's', externalRecipients: ['a@x.example', 'b@x.example', 'c@x.example'], recordsAffected: [], fidelity: 'DERIVED' } })).digest;
      }),
    );
  });
  it('any change to what is shown changes the digest', () => {
    expect(renderPacket(input({ args: { to: ['peter@acme.example'], subject: 'Terms', body: 'Revised terms attached!' } })).digest).not.toBe(renderPacket(input()).digest);
  });
  it('says what happens if nobody decides, flags untrusted fields, recommends, cites the policy', () => {
    const { packet } = renderPacket(input());
    expect(packet.if_you_do_nothing).toEqual({ at: '2026-10-12T14:02:00.000Z', fallback: 'AUTO_REJECT', outcome: 'Not done — gmail.send will not run and the run ends' });
    expect(packet.evidence.untrusted_fields).toEqual(['body']);
    expect(packet.evidence.sources.map((s) => s.id)).toEqual(['contact:peter', 'gmail:msg_44']);
    expect(packet.recommended).toBe('approve');
    expect(packet.policy).toMatchObject({ id: 'external-comms', citation: 'FINRA 2210' });
    expect(packet.what.reversibility_text).toMatch(/pulled back while it is held/);
  });
});

describe('approve with edits: the diff is structural (§5.5)', () => {
  it('records each changed field with its path, before and after', () => {
    const { args, diff } = applyApprovalEdits({ to: ['a@x.example'], subject: 'Hi', body: 'Price is $10.' }, { body: 'Hello.', to: ['a@x.example', 'b@y.example'] });
    expect(args).toMatchObject({ subject: 'Hi', body: 'Hello.' });
    expect(diff).toEqual([
      { path: 'body', op: 'changed', before: 'Price is $10.', after: 'Hello.' },
      { path: 'to[1]', op: 'added', before: null, after: 'b@y.example' },
    ]);
  });
  it('nested objects and removals', () => {
    expect(structuralDiff({ a: { b: 1, c: 2 } }, { a: { b: 1 } })).toEqual([{ path: 'a.c', op: 'removed', before: 2, after: null }]);
    expect(structuralDiff({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

const now = new Date('2026-10-12T10:00:00Z');
const P = (id: string, role: Person['role'], status = 'active'): Person => ({ id, role, status, email: `${id}@x.example` });
const D = (from: string, to: string, over: Partial<DelegationRow> = {}): DelegationRow => ({ id: `${from}>${to}`, fromUser: from, toUser: to, roleScope: null, startsAt: new Date('2026-10-01'), endsAt: new Date('2026-10-20'), revokedAt: null, ...over });

describe('routing (§5.4)', () => {
  const people = [P('req', 'MEMBER'), P('appr', 'APPROVER'), P('adm', 'ADMIN'), P('own', 'OWNER'), P('gone', 'APPROVER', 'deactivated')];
  it('the role named first; never the requester under separation of duties; never an inactive person', () => {
    expect(resolveApprover({ people, delegations: [], role: 'APPROVER', requester: 'req', separationOfDuties: true, now }).assignedTo).toBe('appr');
    expect(resolveApprover({ people: [P('own', 'OWNER'), P('adm', 'ADMIN')], delegations: [], role: 'ADMIN', requester: 'adm', separationOfDuties: true, now }).assignedTo).toBe('own');
  });
  it('honors an active delegation (out of office); ignores an expired or revoked one', () => {
    const away = resolveApprover({ people, delegations: [D('appr', 'adm')], role: 'APPROVER', requester: 'req', separationOfDuties: false, now });
    expect(away).toMatchObject({ assignedTo: 'adm', delegatedFrom: 'appr' });
    expect(resolveApprover({ people, delegations: [D('appr', 'adm', { revokedAt: now })], role: 'APPROVER', requester: 'req', separationOfDuties: false, now }).assignedTo).toBe('appr');
    expect(resolveApprover({ people, delegations: [D('appr', 'adm', { endsAt: new Date('2026-10-05') })], role: 'APPROVER', requester: 'req', separationOfDuties: false, now }).assignedTo).toBe('appr');
  });
  it('self-serve: the owner decides everything', () => {
    expect(resolveApprover({ people, delegations: [], role: 'ADMIN', requester: 'req', separationOfDuties: false, singleUserOwner: 'own', now }).assignedTo).toBe('own');
  });
  it('escalation goes up and stops at OWNER', () => {
    expect([nextRole('APPROVER'), nextRole('ADMIN'), nextRole('OWNER'), nextRole('REGISTERED_PRINCIPAL')]).toEqual(['ADMIN', 'OWNER', null, 'ADMIN']);
  });
  it('decide-time authorization: own role, or an ACTIVE delegation from someone who holds it', () => {
    const map = new Map(people.map((p) => [p.id, p]));
    expect(mayApprove(P('m', 'MEMBER'), 'APPROVER', [], map, now)).toMatchObject({ ok: false });
    expect(mayApprove(P('m', 'MEMBER'), 'APPROVER', [D('appr', 'm')], map, now)).toEqual({ ok: true, onBehalfOf: 'appr' });
    expect(mayApprove(P('m', 'MEMBER'), 'APPROVER', [D('appr', 'm', { endsAt: new Date('2026-10-05') })], map, now)).toMatchObject({ ok: false });
    expect(mayApprove(P('appr', 'APPROVER', 'deactivated'), 'APPROVER', [], map, now)).toMatchObject({ ok: false });
  });
  it('delegation: time-bounded, never more than you hold, never to yourself', () => {
    expect(checkDelegation({ from: P('m', 'MEMBER'), to: P('x', 'MEMBER'), roleScope: null, startsAt: now, endsAt: new Date('2026-10-13') })).toContain('you cannot delegate approval authority you do not hold');
    expect(checkDelegation({ from: P('appr', 'APPROVER'), to: P('x', 'MEMBER'), roleScope: 'OWNER', startsAt: now, endsAt: new Date('2026-10-13') })[0]).toMatch(/do not hold \(OWNER\)/);
    expect(checkDelegation({ from: P('appr', 'APPROVER'), to: P('x', 'MEMBER'), roleScope: null, startsAt: now, endsAt: new Date('2027-03-01') })).toContain('a delegation lasts at most 90 days');
    expect(checkDelegation({ from: P('appr', 'APPROVER'), to: P('x', 'MEMBER'), roleScope: null, startsAt: now, endsAt: new Date('2026-10-13') })).toEqual([]);
  });
});

describe('fallbacks, urgency, rhythm (§5.2, §5.3)', () => {
  it('AUTO_APPROVE only for Low-tier internal undoable actions; never for anything external', () => {
    expect(effectiveFallback({ configured: 'AUTO_APPROVE', tier: 'LOW', egress: 'INTERNAL', reversibility: 'R1', approverRole: 'APPROVER' }).fallback).toBe('AUTO_APPROVE');
    expect(effectiveFallback({ configured: 'AUTO_APPROVE', tier: 'LOW', egress: 'EXTERNAL', reversibility: 'R1', approverRole: 'APPROVER' })).toMatchObject({ fallback: 'AUTO_REJECT', note: expect.stringMatching(/only allowed/) });
    expect(effectiveFallback({ configured: 'AUTO_APPROVE', tier: 'MEDIUM', egress: 'INTERNAL', reversibility: 'R1', approverRole: 'APPROVER' }).fallback).toBe('AUTO_REJECT');
    expect(effectiveFallback({ configured: 'ESCALATE', tier: 'HIGH', egress: 'EXTERNAL', reversibility: 'R2', approverRole: 'APPROVER' })).toMatchObject({ fallback: 'ESCALATE', fallbackRole: 'ADMIN' });
    expect(effectiveFallback({ configured: 'ESCALATE', tier: 'HIGH', egress: 'EXTERNAL', reversibility: 'R2', approverRole: 'OWNER' }).fallback).toBe('AUTO_REJECT');
  });
  it('urgent: Critical, or under an hour left', () => {
    expect([isUrgent('CRITICAL', 9e9), isUrgent('HIGH', 30 * 60_000), isUrgent('HIGH', 4 * 3_600_000)]).toEqual([true, true, false]);
  });
  it('the next review moment (09/13/17 local)', () => {
    expect(nextReviewMoment(new Date('2026-10-12T10:00:00Z')).toISOString()).toBe('2026-10-12T13:00:00.000Z');
    expect(nextReviewMoment(new Date('2026-10-12T18:00:00Z')).toISOString()).toBe('2026-10-13T09:00:00.000Z');
    expect(nextReviewMoment(new Date('2026-10-12T10:00:00Z'), [9, 13, 17], 330).toISOString()).toBe('2026-10-12T11:30:00.000Z'); // 17:00 IST
  });
  it('reject capability: only its hash is kept', () => {
    const { token, hash } = mintRejectToken('6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b');
    expect(token).toMatch(/^ar1\./);
    expect(rejectTokenHash(token)).toBe(hash);
  });
});

describe('rubber-stamp detection (T12, §5.6 — BLOCKING on synthetic behavior)', () => {
  const s = (latencyMs: number, evidenceOpened: boolean, riskTier = 'HIGH', packetChars = 400) => ({ decision: 'approve', latencyMs, evidenceOpened, edited: false, riskTier, packetChars });
  it('a careful approver is not flagged', () => {
    expect(computeQuality(Array.from({ length: 20 }, () => s(15_000, true))).flag).toBeNull();
  });
  it('IMPLAUSIBLE_SPEED: approving faster than the packet can be read', () => {
    const q = computeQuality([...Array.from({ length: 15 }, () => s(12_000, true)), ...Array.from({ length: 5 }, () => s(1_200, true))]);
    expect(plausibleReadMs(400)).toBe(9_000);
    expect(q).toMatchObject({ flag: 'IMPLAUSIBLE_SPEED', tooFastRate: 0.25, decisions: 20 });
  });
  it('NO_EVIDENCE_REVIEW: HIGH/CRITICAL approved without opening the evidence', () => {
    const q = computeQuality(Array.from({ length: 10 }, (_, i) => s(20_000, i < 3)));
    expect(q).toMatchObject({ flag: 'NO_EVIDENCE_REVIEW', highEvidenceOpenRate: 0.3 });
  });
  it('too few decisions to judge: no flag', () => {
    expect(computeQuality([s(500, false), s(500, false)]).flag).toBeNull();
  });
});
