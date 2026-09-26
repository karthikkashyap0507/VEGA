import type { Effect, SimulationFidelity } from '@vega/contracts';
import { setWebBackend } from '@vega/connector-web';
import { compareEffects, type Comparison } from './compare.js';
import { fakeSandbox, type Sandbox } from './sandbox.js';
import { SCENARIOS, type Scenario } from './scenarios.js';

export { compareEffects, type Comparison, type Facet } from './compare.js';
export { fakeSandbox, type Sandbox } from './sandbox.js';
export { SCENARIOS, type Scenario } from './scenarios.js';

/**
 * SIMULATION ACCURACY HARNESS — docs/module2.md §11.2. For each scenario: simulate(), execute(),
 * diff the effects facet by facet, then restore the sandbox. Module 6 reuses this verbatim to
 * test compensators: `restore` becomes "run the compensator and assert the sandbox matches the
 * snapshot taken before execute()".
 *
 * DECLARED-fidelity tools are reported but not held to the threshold: their simulation is, by
 * declaration, a description rather than a prediction — which is exactly why M10 caps their
 * autonomy.
 */

export const ACCURACY_THRESHOLD = 0.99;

export interface ScenarioResult {
  scenario: string;
  toolId: string;
  fidelity: SimulationFidelity | null;
  ok: boolean;
  error?: string;
  comparison?: Comparison;
}

export interface ToolReport {
  toolId: string;
  fidelity: SimulationFidelity | null;
  scenarios: number;
  matched: number;
  compared: number;
  accuracy: number;
  heldToThreshold: boolean;
  passed: boolean;
  failures: string[];
}

export interface Report {
  generatedAt: string;
  sandbox: 'fake' | 'live';
  threshold: number;
  tools: ToolReport[];
  results: ScenarioResult[];
  passed: boolean;
}

export interface HarnessOptions {
  scenarios?: Scenario[];
  sandbox?: () => Sandbox;
  /** Restores the sandbox after a scenario. Default: each scenario gets a fresh fake sandbox. */
  restore?: (s: Sandbox, executed: Effect<unknown>) => Promise<void>;
}

/** Deterministic web backend for the fake sandbox: the same page on every call. */
function fakeWeb() {
  setWebBackend({
    fetch: async (url) => ({ url, status: 200, contentType: 'text/html', title: 'Pricing', text: 'Plans start at $10.', truncated: false }),
    search: async (q) => [{ url: 'https://example.com/a', title: `Result for ${q}`, snippet: '…' }],
  });
}

export async function runScenario(s: Sandbox, scenario: Scenario, restore?: HarnessOptions['restore']): Promise<ScenarioResult> {
  const tool = s.registry.get(scenario.toolId)?.tool;
  const fidelity = tool?.simulateFidelity ?? null;
  try {
    const connectorId = await s.connect(scenario.kind, [scenario.toolId], scenario.config ?? {});
    const args = await scenario.setup(s);
    const input = { tenantId: s.tenantId, connectorId, toolId: scenario.toolId, args };
    const sim = await s.runtime.simulate(input);
    if (!sim.ok) return { scenario: scenario.name, toolId: scenario.toolId, fidelity, ok: false, error: `simulate: ${sim.error.code} ${sim.error.message}` };
    const exe = await s.runtime.execute({ ...input, runId: `sim-eval-${scenario.toolId}`, nodeId: scenario.name });
    if (!exe.ok) return { scenario: scenario.name, toolId: scenario.toolId, fidelity, ok: false, error: `execute: ${exe.error.code} ${exe.error.message}` };
    const comparison = compareEffects(sim.effect, exe.effect);
    if (restore) await restore(s, exe.effect);
    return { scenario: scenario.name, toolId: scenario.toolId, fidelity, ok: true, comparison };
  } catch (error) {
    return { scenario: scenario.name, toolId: scenario.toolId, fidelity, ok: false, error: (error as Error).message };
  }
}

export async function runHarness(options: HarnessOptions = {}): Promise<Report> {
  const scenarios = options.scenarios ?? SCENARIOS;
  const make = options.sandbox ?? fakeSandbox;
  if (!options.sandbox) fakeWeb();
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(make(), scenario, options.restore));
  setWebBackend(undefined);

  const byTool = new Map<string, ScenarioResult[]>();
  for (const r of results) byTool.set(r.toolId, [...(byTool.get(r.toolId) ?? []), r]);
  const tools: ToolReport[] = [...byTool.entries()]
    .map(([toolId, rs]) => {
      const matched = rs.reduce((a, r) => a + (r.comparison?.matched ?? 0), 0);
      const compared = rs.reduce((a, r) => a + (r.comparison?.compared ?? 1), 0);
      const fidelity = rs[0]?.fidelity ?? null;
      const heldToThreshold = fidelity !== 'DECLARED';
      const errored = rs.some((r) => !r.ok);
      const accuracy = errored ? 0 : compared ? matched / compared : 1;
      const failures = rs.flatMap((r) =>
        r.ok ? (r.comparison?.facets ?? []).filter((f) => !f.equal).map((f) => `${r.scenario}: ${f.name} simulated ${JSON.stringify(f.simulated)} executed ${JSON.stringify(f.executed)}`) : [`${r.scenario}: ${r.error}`],
      );
      return { toolId, fidelity, scenarios: rs.length, matched, compared, accuracy, heldToThreshold, passed: !errored && (!heldToThreshold || accuracy >= ACCURACY_THRESHOLD), failures };
    })
    .sort((a, b) => a.toolId.localeCompare(b.toolId));
  return {
    generatedAt: new Date().toISOString(),
    sandbox: options.sandbox ? 'live' : 'fake',
    threshold: ACCURACY_THRESHOLD,
    tools,
    results,
    passed: tools.every((t) => t.passed),
  };
}

export function markdown(report: Report): string {
  const rows = report.tools.map(
    (t) => `| \`${t.toolId}\` | ${t.fidelity ?? '—'} | ${t.scenarios} | ${(t.accuracy * 100).toFixed(1)}% | ${t.heldToThreshold ? (t.passed ? 'pass' : '**FAIL**') : 'reported (DECLARED)'} |`,
  );
  const failures = report.tools.flatMap((t) => t.failures.map((f) => `- \`${t.toolId}\` ${f}`));
  return [
    `# Simulation accuracy — ${report.generatedAt}`,
    '',
    `Sandbox: ${report.sandbox}. Threshold: ${report.threshold * 100}% (docs/module2.md §12).`,
    '',
    '| Tool | Fidelity | Scenarios | Accuracy | Result |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    failures.length ? '## Mismatches\n\n' + failures.join('\n') : 'No mismatches.',
    '',
  ].join('\n');
}
