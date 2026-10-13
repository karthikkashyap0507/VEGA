import { describe, expect, it } from 'vitest';
import { capture, evaluate, featuresOf, isPromotion, moreRestrictive, sample, score, stricter, TIERS, UNTIERED, type Tier } from '../src/index.js';

describe('the ladder (§2, §7)', () => {
  it('has five tiers, and only single steps up are promotions', () => {
    expect(TIERS).toEqual(['SHADOW', 'SUPERVISED', 'SAMPLED', 'AUTONOMOUS', 'SUSPENDED']);
    expect(isPromotion('SHADOW', 'SUPERVISED')).toBe(true);
    expect(isPromotion('SUPERVISED', 'SAMPLED')).toBe(true);
    expect(isPromotion('SAMPLED', 'AUTONOMOUS')).toBe(true);
    // skipping a rung, going sideways, and leaving SUSPENDED are never promotions
    expect(isPromotion('SHADOW', 'SAMPLED')).toBe(false);
    expect(isPromotion('SUPERVISED', 'AUTONOMOUS')).toBe(false);
    expect(isPromotion('SUSPENDED', 'SAMPLED')).toBe(false);
    expect(isPromotion('SUSPENDED', 'SHADOW')).toBe(false);
    expect(isPromotion('AUTONOMOUS', 'SAMPLED')).toBe(false);
  });

  it('SUSPENDED blocks; SHADOW and SUPERVISED require a person; AUTONOMOUS adds nothing', () => {
    const at = (tier: Tier) => evaluate({ tier, sampleRate: null, sampleKey: 'k' });
    expect(at('SUSPENDED').floor).toBe('DENY');
    expect(at('SHADOW').floor).toBe('REQUIRE_APPROVAL');
    expect(at('SUPERVISED').floor).toBe('REQUIRE_APPROVAL');
    expect(at('AUTONOMOUS').floor).toBeNull();
  });

  it('no row at all adds nothing: "blocks nothing" by default (§1)', () => {
    expect(UNTIERED.floor).toBeNull();
  });

  it('★ autonomy can only downgrade a disposition, never upgrade it (§7)', () => {
    const rank = { ALLOW: 0, ALLOW_WITH_HOLD: 1, HOLD: 1, REQUIRE_APPROVAL: 2, REQUIRE_DUAL_APPROVAL: 3, DENY: 4 } as const;
    for (const policy of Object.keys(rank) as Array<keyof typeof rank>) {
      for (const tier of TIERS) {
        for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
          const r = evaluate({ tier, sampleRate: 3, sampleKey: key });
          const folded = r.floor ? stricter(policy, r.floor) : policy;
          // whatever the tier says, the outcome is never LESS strict than policy's own decision
          expect(rank[folded], ).toBeGreaterThanOrEqual(rank[policy]);
        }
      }
    }
    // an explicit policy requirement survives AUTONOMOUS untouched
    expect(evaluate({ tier: 'AUTONOMOUS', sampleRate: null, sampleKey: 'k' }).floor).toBeNull();
    expect(stricter('REQUIRE_APPROVAL', 'ALLOW')).toBe('REQUIRE_APPROVAL');
    expect(stricter('REQUIRE_DUAL_APPROVAL', 'REQUIRE_APPROVAL')).toBe('REQUIRE_DUAL_APPROVAL');
    // and SUSPENDED turns even an ALLOW into a DENY
    expect(stricter('ALLOW', evaluate({ tier: 'SUSPENDED', sampleRate: null, sampleKey: 'k' }).floor!)).toBe('DENY');
  });

  it('SAMPLED is a deterministic 1-in-N, stable across replays', () => {
    const keys = Array.from({ length: 5000 }, (_, i) => `run-${i}:1`);
    const hits = keys.filter((k) => sample(k, 5)).length;
    expect(hits).toBeGreaterThan(5000 / 5 - 150);
    expect(hits).toBeLessThan(5000 / 5 + 150);
    for (const k of keys.slice(0, 50)) expect(sample(k, 5)).toBe(sample(k, 5));
    expect(sample('anything', 1)).toBe(true);
    const r = evaluate({ tier: 'SAMPLED', sampleRate: 5, sampleKey: keys.find((k) => sample(k, 5))! });
    expect(r).toMatchObject({ sampled: true, floor: 'REQUIRE_APPROVAL' });
    const miss = evaluate({ tier: 'SAMPLED', sampleRate: 5, sampleKey: keys.find((k) => !sample(k, 5))! });
    expect(miss).toMatchObject({ sampled: false, floor: null });
  });

  it('demotion must move strictly toward more supervision', () => {
    expect(moreRestrictive('AUTONOMOUS', 'SUSPENDED')).toBe(true);
    expect(moreRestrictive('SAMPLED', 'SUPERVISED')).toBe(true);
    expect(moreRestrictive('SUPERVISED', 'SHADOW')).toBe(false); // enforced identically
    expect(moreRestrictive('SUSPENDED', 'SUPERVISED')).toBe(false);
  });
});

describe('novelty (§6.1): feature statistics + distance, never an opaque model', () => {
  const typical = Array.from({ length: 60 }, (_, i) => featuresOf({ recipients: [`p${i}@acme.example`], textLength: 400 + (i % 7) * 20, at: new Date(Date.UTC(2026, 0, 5, 9 + (i % 4))), valueCents: 5000 + (i % 5) * 300 }));
  const baseline = capture(typical);

  it('an input like the certified sample is not novel', () => {
    const s = score(featuresOf({ recipients: ['x@acme.example'], textLength: 430, at: new Date(Date.UTC(2026, 0, 6, 10)), valueCents: 5300 }), baseline);
    expect(s).toMatchObject({ novel: false, reasons: [] });
  });

  it('a recipient domain never seen is novel, and says why', () => {
    const s = score(featuresOf({ recipients: ['x@competitor.example'], textLength: 430, at: new Date(Date.UTC(2026, 0, 6, 10)) }), baseline);
    expect(s.novel).toBe(true);
    expect(s.reasons[0]).toMatch(/competitor\.example.*never seen/);
  });

  it('a value far outside the distribution is novel, with its σ distance', () => {
    const s = score(featuresOf({ recipients: ['x@acme.example'], textLength: 430, at: new Date(Date.UTC(2026, 0, 6, 10)), valueCents: 5_000_000 }), baseline);
    expect(s.novel).toBe(true);
    expect(s.reasons.join(' ')).toMatch(/value 50000\.00 is .*σ/);
  });

  it('too few certified samples never produces a z-score verdict', () => {
    const tiny = capture(typical.slice(0, 5));
    expect(score(featuresOf({ recipients: ['x@acme.example'], textLength: 99_999, at: new Date() }), tiny).novel).toBe(false);
  });

  it('an entity type never certified is novel', () => {
    const b = capture([{ domain: 'a.example', entityTypes: ['contact'] }, { domain: 'a.example', entityTypes: ['contact'] }]);
    expect(score({ domain: 'a.example', entityTypes: ['invoice'] }, b).novel).toBe(true);
  });
});
