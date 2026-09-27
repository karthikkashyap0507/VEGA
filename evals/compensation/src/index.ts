import { canonical } from '@vega/compensators';
import { isHoldOnly, type CompensationToken, type ToolRegistry } from '@vega/connector-sdk';
import { launchRegistry } from '@vega/connectors';
import { fakeSandbox, type Sandbox } from '@vega/eval-simulation';
import { SCENARIOS, type CompensationScenario } from './scenarios.js';

export { SCENARIOS, type CompensationScenario } from './scenarios.js';

/**
 * COMPENSATOR CORRECTNESS HARNESS — docs/module6.md §11.1. Per scenario, against the sandbox
 * provider (never a mock of the compensator):
 *
 *   1. snapshot the provider state the action touches
 *   2. capture() the compensation token, then execute() the forward action
 *   3. assert the effect occurred (the state changed)
 *   4. compensate()
 *   5. assert the state equals the snapshot, modulo the declared-approximate fields
 *   6. compensate() again: assert no additional effect — same state, no new provider writes,
 *      no second notification to anyone
 *
 * plus the honesty checks: a SILENT compensator notified nobody; a NOTIFIES_THIRD_PARTY one
 * reported exactly the people the provider actually told.
 *
 * The success rate over all scenarios is held to ≥ 99% (§12), and the build fails if any
 * registered R1/R2 tool has no scenario ("a connector cannot register without it").
 */

export const SUCCESS_THRESHOLD = 0.99;

export interface ScenarioResult {
  scenario: string;
  toolId: string;
  ref: string;
  ok: boolean;
  failures: string[];
  outcome?: string;
  secondOutcome?: string;
  notified?: string[];
  writesOnSecondRun?: number;
  durationMs: number;
}

export interface CompensationReport {
  generatedAt: string;
  sandbox: 'fake' | 'live';
  threshold: number;
  scenarios: number;
  passed: number;
  successRate: number;
  /** R1/R2 tools and how each is covered. */
  coverage: Array<{ toolId: string; reversibility: string; ref: string; kind: 'compensator' | 'hold-only'; scenarios: number }>;
  uncovered: string[];
  results: ScenarioResult[];
  ok: boolean;
}

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const notificationsOf = (s: Sandbox) => [...s.providers.google.notifications, ...s.providers.microsoft.notifications];

export async function runScenario(sc: CompensationScenario, sandbox: () => Sandbox = fakeSandbox): Promise<ScenarioResult> {
  const started = Date.now();
  const s = sandbox();
  const failures: string[] = [];
  const fail = (msg: string) => failures.push(msg);
  const comparable = (v: unknown) => canonical(sc.comparable ? sc.comparable(v) : v);
  const found = s.registry.get(sc.toolId);
  const comp = found ? s.registry.compensatorFor(found.tool) : undefined;
  const ref = comp?.ref ?? '(none)';
  const result = (extra: Partial<ScenarioResult> = {}): ScenarioResult => ({ scenario: sc.name, toolId: sc.toolId, ref, ok: failures.length === 0, failures, durationMs: Date.now() - started, ...extra });
  if (!found || !comp || isHoldOnly(comp)) {
    fail(`${sc.toolId} has no runnable compensator`);
    return result();
  }
  const connectorId = await s.connect(sc.kind, s.registry.toolsFor(sc.kind).map((t) => t.toolId));
  const args = await sc.setup(s);
  const call = { tenantId: s.tenantId, connectorId, toolId: sc.toolId, args, runId: '11111111-1111-4111-8111-111111111111', nodeId: `v1.${sc.name.length}` };

  // 1–2: snapshot, capture, execute
  const initial = sc.state(s, args);
  const captured = await s.runtime.capture(call);
  if (!captured.ok || captured.kind !== 'armed') {
    fail(`capture failed: ${captured.ok ? captured.kind : `${captured.error.code} ${captured.error.message}`}`);
    return result();
  }
  const exe = await s.runtime.execute(call);
  if (!exe.ok) {
    fail(`forward call failed: ${exe.error.code} ${exe.error.message}`);
    return result();
  }
  // 3: the effect occurred
  const afterForward = sc.state(s, args);
  if (comparable(afterForward) === comparable(initial)) fail('the forward call changed nothing the scenario observes');

  // 4–5: compensate, compare with the snapshot
  const token: CompensationToken = {
    ...captured.token,
    forward: sc.forwardUnknown ? null : { providerRef: exe.providerRef, detail: exe.effect.detail, recordsAffected: exe.effect.recordsAffected },
  };
  const before = notificationsOf(s).length;
  const first = await s.runtime.compensate({ tenantId: s.tenantId, connectorId, token, compensationId: `c-${sc.name}` });
  if (!first.ok) {
    fail(`compensation failed: ${first.error.code} ${first.error.message}`);
    return result();
  }
  if (first.result.outcome !== 'restored') fail(`first compensation reported "${first.result.outcome}", expected "restored"`);
  const restored = sc.state(s, args);
  if (comparable(restored) !== comparable(initial)) fail(`state after compensation differs from the snapshot:\n  before:   ${comparable(initial)}\n  restored: ${comparable(restored)}`);
  const told = notificationsOf(s).slice(before).flatMap((n) => n.to);
  if (captured.compensator.sideEffects === 'SILENT' && told.length) fail(`declared SILENT but the provider notified ${told.join(', ')}`);
  if (canonical([...new Set(told)].sort()) !== canonical([...new Set(first.result.notified)].sort())) {
    fail(`reported notifying [${first.result.notified.join(', ')}] but the provider told [${told.join(', ')}]`);
  }

  // 6: again — no additional effect
  const callsBefore = s.providers.core.calls.length;
  const notesBefore = notificationsOf(s).length;
  const second = await s.runtime.compensate({ tenantId: s.tenantId, connectorId, token, compensationId: `c-${sc.name}` });
  // A write the provider REFUSED (404: already gone) changed nothing; one it accepted did.
  const writes = s.providers.core.calls.slice(callsBefore).filter((c) => WRITE.has(c.method) && !c.url.includes('/freeBusy') && (c.status ?? 200) < 300).length;
  if (!second.ok) fail(`second compensation failed: ${second.error.code} ${second.error.message}`);
  else if (second.result.outcome === 'restored') fail('second compensation reported "restored": it is not idempotent');
  if (writes) fail(`second compensation made ${writes} provider write(s) that took effect`);
  if (notificationsOf(s).length !== notesBefore) fail('second compensation notified someone again');
  if (comparable(sc.state(s, args)) !== comparable(restored)) fail('second compensation changed the state');

  return result({ outcome: first.result.outcome, ...(second.ok ? { secondOutcome: second.result.outcome } : {}), notified: first.result.notified, writesOnSecondRun: writes });
}

/** Every R1/R2 tool the launch registry holds, and whether a scenario (or the hold) covers it. */
export function coverage(registry: ToolRegistry, scenarios: readonly CompensationScenario[]): Pick<CompensationReport, 'coverage' | 'uncovered'> {
  const rows: CompensationReport['coverage'] = [];
  const uncovered: string[] = [];
  for (const def of registry.allConnectors()) {
    for (const tool of def.tools) {
      if (tool.reversibility !== 'R1' && tool.reversibility !== 'R2') continue;
      const c = registry.compensatorFor(tool);
      const n = scenarios.filter((s) => s.toolId === tool.toolId).length;
      const holdOnly = c ? isHoldOnly(c) : false;
      rows.push({ toolId: tool.toolId, reversibility: tool.reversibility, ref: tool.compensatorRef ?? '', kind: holdOnly ? 'hold-only' : 'compensator', scenarios: n });
      // A hold-only R2 tool's undo is the hold window: the executor's hold suite covers it.
      if (!c || (!holdOnly && n === 0)) uncovered.push(tool.toolId);
    }
  }
  return { coverage: rows.sort((a, b) => a.toolId.localeCompare(b.toolId)), uncovered };
}

export async function runHarness(opts: { scenarios?: CompensationScenario[]; sandbox?: () => Sandbox } = {}): Promise<CompensationReport> {
  const scenarios = opts.scenarios ?? SCENARIOS;
  const results: ScenarioResult[] = [];
  for (const sc of scenarios) results.push(await runScenario(sc, opts.sandbox));
  const passed = results.filter((r) => r.ok).length;
  const successRate = results.length ? passed / results.length : 1;
  const cov = coverage(launchRegistry(), scenarios);
  return {
    generatedAt: new Date().toISOString(),
    sandbox: 'fake',
    threshold: SUCCESS_THRESHOLD,
    scenarios: results.length,
    passed,
    successRate,
    ...cov,
    results,
    ok: successRate >= SUCCESS_THRESHOLD && cov.uncovered.length === 0,
  };
}

export function markdown(r: CompensationReport): string {
  const lines = [
    '# Compensator correctness',
    '',
    `Generated ${r.generatedAt} against the ${r.sandbox} sandbox. ${r.passed}/${r.scenarios} scenarios passed (${(r.successRate * 100).toFixed(1)}%; threshold ${(r.threshold * 100).toFixed(0)}%).`,
    '',
    '| Tool | Class | Compensator | Covered by | Scenarios |',
    '|---|---|---|---|---|',
    ...r.coverage.map((c) => `| \`${c.toolId}\` | ${c.reversibility} | \`${c.ref}\` | ${c.kind === 'hold-only' ? 'the hold window (executor suite)' : 'this harness'} | ${c.scenarios} |`),
    '',
    '| Scenario | Tool | First | Second | Notified | Result |',
    '|---|---|---|---|---|---|',
    ...r.results.map((x) => `| ${x.scenario} | \`${x.toolId}\` | ${x.outcome ?? '–'} | ${x.secondOutcome ?? '–'} | ${x.notified?.length ?? 0} | ${x.ok ? 'pass' : `FAIL: ${x.failures[0]?.split('\n')[0]}`} |`),
    ...(r.uncovered.length ? ['', `**Uncovered R1/R2 tools:** ${r.uncovered.join(', ')}`] : []),
  ];
  return lines.join('\n') + '\n';
}
