import { describe, expect, it } from 'vitest';
import { renderPacket, type PacketInput } from '../src/index.js';

/** Module 9 in the M8 packet (§8.3): the verification panel and the unsupported claims, highlighted. */

const base: PacketInput = {
  request: { toolId: 'gmail.send', toolTitle: 'Send email', approverRole: 'APPROVER', approvalsRequired: 1, separationOfDuties: false, expiresAt: '2026-10-12T14:02:00.000Z', fallback: 'AUTO_REJECT', fallbackRole: null, urgency: 'normal' },
  run: { id: 'run-1', objective: 'Tell Dana the renewal covers 40 seats', trigger: 'chat', requestedBy: 'u1', requestedByName: 'Ana', startedAt: '2026-10-12T10:02:00.000Z' },
  action: { args: { to: ['dana@acme.example'], body: 'Your renewal covers 40 seats at $9,999.' }, reversibility: 'R2', egress: 'EXTERNAL', holdWindowMs: null, effect: { summary: 'Send 1 email', externalRecipients: ['dana@acme.example'], recordsAffected: [], fidelity: 'DERIVED' } },
  provenance: { argTaint: 'TRUSTED', argTaints: [] },
  risk: { score: 70, tier: 'HIGH' },
  policy: { decision: 'REQUIRE_APPROVAL', decidedBy: null, reason: 'verification: groundedness: 1 of 2 claims unsupported', citation: null, chain: [] },
};
const verification = {
  outcome: 'ESCALATE',
  checks: [
    { check: 'permissions', outcome: 'PASS', detail: 'current at execution time' },
    { check: 'groundedness', outcome: 'ESCALATE', detail: '1 of 2 claims unsupported' },
  ],
  unsupportedClaims: [{ text: '$9,999', reason: 'no trusted source supports this price' }],
};

describe('the packet with verification', () => {
  it('lists the unsupported claims and the checks, and recommends a closer look', () => {
    const { packet } = renderPacket({ ...base, verification });
    expect(packet.evidence.unsupported_claims).toEqual([{ text: '$9,999', reason: 'no trusted source supports this price' }]);
    expect(packet.verification).toEqual({ outcome: 'ESCALATE', checks: verification.checks });
    expect(packet.recommended).toBe('reject');
  });

  it('a packet without verification is unchanged (same digest as before Module 9)', () => {
    const { packet, digest } = renderPacket(base);
    expect(packet).not.toHaveProperty('verification');
    expect(packet.evidence.unsupported_claims).toEqual([]);
    expect(renderPacket({ ...base, verification: undefined }).digest).toBe(digest);
  });

  it('the findings are part of what the digest commits to', () => {
    expect(renderPacket({ ...base, verification }).digest).not.toBe(renderPacket(base).digest);
  });
});
