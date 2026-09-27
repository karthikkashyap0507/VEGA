import { describe, expect, it } from 'vitest';
import { launchRegistry } from '@vega/connectors';
import { coverage, runHarness, runScenario, SCENARIOS, SUCCESS_THRESHOLD } from '../src/index.js';

/**
 * docs/module6.md §11 — BLOCKING: "Compensator correctness (custom, against sandbox providers):
 * a connector cannot register without it" and "Compensation idempotency: compensate twice, one
 * effect". Every scenario must pass; the rate is also held to the ≥ 99% threshold.
 */
describe('compensator correctness harness', () => {
  it('covers every registered R1/R2 tool (a hold-only R2 is covered by the hold suite)', () => {
    const { coverage: rows, uncovered } = coverage(launchRegistry(), SCENARIOS);
    expect(uncovered).toEqual([]);
    expect(rows.filter((r) => r.kind === 'hold-only').map((r) => r.toolId).sort()).toEqual(['gmail.send', 'outlook.send']);
    // Every R1 has a real inverse.
    expect(rows.filter((r) => r.reversibility === 'R1').every((r) => r.kind === 'compensator' && r.scenarios > 0)).toBe(true);
  });

  for (const sc of SCENARIOS) {
    it(`${sc.toolId}: ${sc.name}`, async () => {
      const r = await runScenario(sc);
      expect(r.failures).toEqual([]);
      expect(r.outcome).toBe('restored');
      expect(['already_restored', 'not_needed']).toContain(r.secondOutcome);
      expect(r.writesOnSecondRun).toBe(0);
    });
  }

  it(`holds the success rate to ${SUCCESS_THRESHOLD * 100}%`, async () => {
    const report = await runHarness();
    expect(report.successRate).toBeGreaterThanOrEqual(SUCCESS_THRESHOLD);
    expect(report.ok).toBe(true);
  });
});
