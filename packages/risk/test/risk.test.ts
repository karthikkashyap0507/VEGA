import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkWeights, DEFAULT_WEIGHTS, scoreRisk, type RiskInput, type Tier } from '../src/index.js';

/**
 * The risk function (docs/module5.md §11): table-driven cases for the PROJECT.md §7.3 tiers,
 * every hard gate positive and negative, and reproducibility from stored factors.
 */

const base: RiskInput = {
  sensitivity: 10,
  labels: [],
  effect: { recipients: 0, externalRecipients: 0, recordsAffected: 0 },
  egressClass: 'INTERNAL',
  reversibility: 'R0',
  principalRole: 'MEMBER',
  argTaint: 'TRUSTED',
  recipientTaint: 'TRUSTED',
  inScope: true,
};
const at = (patch: Partial<RiskInput>): RiskInput => ({ ...base, ...patch, effect: { ...base.effect, ...(patch.effect ?? {}) } });

describe('the §7.3 tiers, computed', () => {
  it.each<[string, RiskInput, Tier]>([
    ['summarize my emails', at({ sensitivity: 10 }), 'LOW'],
    ['draft a response to this customer (content from their email)', at({ sensitivity: 20, reversibility: 'R1', argTaint: 'UNTRUSTED', effect: { recipients: 1, externalRecipients: 0, recordsAffected: 1 } }), 'MEDIUM'],
    ['a plain external email to a trusted contact', at({ reversibility: 'R2', egressClass: 'EXTERNAL', effect: { recipients: 1, externalRecipients: 1, recordsAffected: 1 } }), 'MEDIUM'],
    ['send this confidential document externally', at({ sensitivity: 70, reversibility: 'R2', egressClass: 'EXTERNAL', effect: { recipients: 1, externalRecipients: 1, recordsAffected: 1 } }), 'HIGH'],
    ['delete all project records', at({ sensitivity: 30, reversibility: 'R3', effect: { recipients: 0, externalRecipients: 0, recordsAffected: 200 } }), 'CRITICAL'],
  ])('%s → %s', (_name, input, tier) => {
    expect(scoreRisk(input).tier).toBe(tier);
  });

  it('the explanation names every factor with its weight and contribution', () => {
    const r = scoreRisk(at({ reversibility: 'R2', egressClass: 'EXTERNAL', argTaint: 'UNTRUSTED' }));
    expect(r.explanation.map((e) => e.factor)).toEqual(['dataSensitivity', 'blastRadius', 'externalExposure', 'irreversibility', 'authorityGap', 'taintPressure', 'certificationCredit']);
    expect(r.explanation.find((e) => e.factor === 'taintPressure')).toMatchObject({ value: 100, weight: 0.25, contribution: 25 });
  });

  it('authority: a member may send; only workflow owners and admins carry irreversible authority', () => {
    expect(scoreRisk(at({ reversibility: 'R2', egressClass: 'EXTERNAL' })).factors.authorityGap).toBe(0);
    expect(scoreRisk(at({ reversibility: 'R3' })).factors.authorityGap).toBe(34);
    expect(scoreRisk(at({ reversibility: 'R3', principalRole: 'ADMIN' })).factors.authorityGap).toBe(0);
    expect(scoreRisk(at({ reversibility: 'R2', egressClass: 'EXTERNAL', principalRole: 'AUDITOR' })).factors.authorityGap).toBe(68);
  });

  it('certification credit lowers the score (Module 10 supplies it)', () => {
    const plain = at({ reversibility: 'R2', egressClass: 'EXTERNAL', effect: { recipients: 1, externalRecipients: 1, recordsAffected: 1 } });
    expect(scoreRisk({ ...plain, certification: { agreementRate: 100 } }).score).toBeLessThan(scoreRisk(plain).score);
  });
});

describe('hard gates — never overridable by a good score', () => {
  const quiet = at({ sensitivity: 0, principalRole: 'OWNER' });
  it('R3 + EXTERNAL → at least HIGH (and not for R3 internal, or R2 external)', () => {
    const r = scoreRisk({ ...quiet, reversibility: 'R3', egressClass: 'EXTERNAL', certification: { agreementRate: 100 } });
    expect(r.scoreTier).not.toBe('HIGH');
    expect(r).toMatchObject({ tier: 'HIGH', hardGates: ['R3_EXTERNAL'] });
    expect(scoreRisk({ ...quiet, reversibility: 'R3', egressClass: 'INTERNAL' }).hardGates).toEqual([]);
    expect(scoreRisk({ ...quiet, reversibility: 'R2', egressClass: 'EXTERNAL' }).hardGates).toEqual([]);
  });
  it('an UNTRUSTED recipient → CRITICAL; an ORG or TRUSTED one does not fire', () => {
    expect(scoreRisk({ ...quiet, recipientTaint: 'UNTRUSTED' })).toMatchObject({ tier: 'CRITICAL', hardGates: ['UNTRUSTED_RECIPIENT'] });
    expect(scoreRisk({ ...quiet, recipientTaint: 'ORG' }).hardGates).toEqual([]);
  });
  it('out of scope → CRITICAL (the policy layer turns it into DENY)', () => {
    expect(scoreRisk({ ...quiet, inScope: false })).toMatchObject({ tier: 'CRITICAL', hardGates: ['OUT_OF_SCOPE'] });
  });
  it('a RESTRICTED resource → at least HIGH (dual approval is applied by the policy layer)', () => {
    expect(scoreRisk({ ...quiet, labels: ['RESTRICTED'] })).toMatchObject({ tier: 'HIGH', hardGates: ['RESTRICTED_RESOURCE'] });
    expect(scoreRisk({ ...quiet, labels: ['CONFIDENTIAL'] }).hardGates).toEqual([]);
  });
  it('property: a hard gate only ever raises the tier', () => {
    const order: Tier[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    fc.assert(
      fc.property(
        fc.record({
          sensitivity: fc.integer({ min: 0, max: 100 }),
          labels: fc.subarray(['PII', 'PHI', 'RESTRICTED', 'SECRET']),
          effect: fc.record({ recipients: fc.nat(40), externalRecipients: fc.nat(40), recordsAffected: fc.nat(1000) }),
          egressClass: fc.constantFrom('INTERNAL', 'EXTERNAL', 'PUBLIC'),
          reversibility: fc.constantFrom('R0', 'R1', 'R2', 'R3'),
          principalRole: fc.constantFrom('OWNER', 'ADMIN', 'WORKFLOW_OWNER', 'APPROVER', 'MEMBER'),
          argTaint: fc.constantFrom('TRUSTED', 'ORG', 'UNTRUSTED'),
          recipientTaint: fc.constantFrom('TRUSTED', 'ORG', 'UNTRUSTED'),
          inScope: fc.boolean(),
        }) as fc.Arbitrary<RiskInput>,
        (input) => {
          const r = scoreRisk(input);
          expect(order.indexOf(r.tier)).toBeGreaterThanOrEqual(order.indexOf(r.scoreTier));
          expect(r.score).toBeGreaterThanOrEqual(0);
          expect(r.score).toBeLessThanOrEqual(100);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('reproducibility (BLOCKING)', () => {
  it('a stored evaluation — input and weights, as JSON — reproduces the identical result', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), fc.nat(500), fc.constantFrom('R0', 'R1', 'R2', 'R3'), fc.constantFrom('INTERNAL', 'EXTERNAL', 'PUBLIC'), (sens, records, rev, egress) => {
        const input = at({ sensitivity: sens, reversibility: rev as RiskInput['reversibility'], egressClass: egress as RiskInput['egressClass'], effect: { recipients: 2, externalRecipients: 1, recordsAffected: records } });
        const stored = JSON.parse(JSON.stringify({ input, weights: DEFAULT_WEIGHTS, result: scoreRisk(input) }));
        expect(scoreRisk(stored.input, stored.weights)).toEqual(stored.result);
      }),
      { numRuns: 300 },
    );
  });
  it('the weights version is recorded; a different version may score differently', () => {
    const w2 = { ...DEFAULT_WEIGHTS, version: 2, w4: 0.6 };
    const input = at({ reversibility: 'R2', egressClass: 'EXTERNAL' });
    expect(scoreRisk(input, w2).weightsVersion).toBe(2);
    expect(scoreRisk(input, w2).score).toBeGreaterThan(scoreRisk(input).score);
  });
});

describe('weights are bounded', () => {
  it('rejects weights outside their bounds and incoherent boundaries', () => {
    expect(checkWeights(DEFAULT_WEIGHTS)).toEqual([]);
    expect(checkWeights({ ...DEFAULT_WEIGHTS, w6: 0 })).toEqual(['w6 must be between 0.1 and 0.6']);
    expect(checkWeights({ ...DEFAULT_WEIGHTS, boundaries: { low: 50, medium: 40, high: 80 } })).toHaveLength(1);
  });
});
