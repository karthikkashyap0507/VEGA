import { describe, expect, it } from 'vitest';
import { LAUNCH_CONNECTORS } from '@vega/connectors';
import { ACCURACY_THRESHOLD, compareEffects, runHarness, SCENARIOS } from '../src/index.js';

describe('simulation accuracy harness', () => {
  it('has a scenario for every launch tool', () => {
    const covered = new Set(SCENARIOS.map((s) => s.toolId));
    const missing = LAUNCH_CONNECTORS.flatMap((c) => c.tools.map((t) => t.toolId)).filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });

  it(`every non-DECLARED tool predicts its executed effect at ≥ ${ACCURACY_THRESHOLD * 100}%`, async () => {
    const report = await runHarness();
    const failing = report.tools.filter((t) => !t.passed).map((t) => `${t.toolId} ${(t.accuracy * 100).toFixed(1)}%: ${t.failures.join(' | ')}`);
    expect(failing).toEqual([]);
    expect(report.tools.length).toBeGreaterThanOrEqual(25);
  });

  it('the comparator catches a wrong prediction', () => {
    const base = { summary: 's', fidelity: 'DERIVED' as const, recordsAffected: [{ system: 'gmail', id: 'm1' }], detail: { subject: 'A', messageId: null } };
    const ok = compareEffects({ ...base, externalRecipients: ['x@p.example'] }, { ...base, externalRecipients: ['X@p.example'], detail: { subject: 'A', messageId: 'm1' } });
    expect(ok.score).toBe(1);
    const wrong = compareEffects({ ...base, externalRecipients: [] }, { ...base, externalRecipients: ['x@p.example'], detail: { subject: 'B', messageId: 'm1' } });
    expect(wrong.facets.filter((f) => !f.equal).map((f) => f.name).sort()).toEqual(['detail.subject', 'externalRecipients']);
  });
});
