import { createHash } from 'node:crypto';
import type { Ambiguity, PlannerInput, PlannerTool, SourceMetadata, TaintLevel } from '@vega/contracts';
import { ambiguityPolicy, callBound, callsOf, parse, ParseError, type Program, type ValidationIssue } from '@vega/dsl';
import type { LlmClient } from '@vega/llm';
import { plan, PlanError } from '@vega/planner';
import type { LoadedRun, PlanRow } from '@vega/runs';
import { canonicalJson } from '@vega/taint';
import type { ExecutionClient, ValidationView } from '../connectors/deps.js';

/**
 * C2 — THE TASK PLANNER (docs/module4.md §5.2).
 *
 *   metadata prompt → model → parse → static validation (M3) + BOUNDS (max_steps, max_fanout,
 *   the agent's tool allowlist) → valid: persist + pre-annotate · invalid: ONE bounded replan
 *
 * Pre-annotation is the point: every tool call gets planned reversibility, egress, taint and the
 * gate's predicted decision BEFORE anything executes, so M5 can gate a plan as a whole and M6
 * can simulate its blast radius.
 *
 * After a valid plan, C1's ambiguity policy is applied with the plan in hand (§5.1 rule 3): an
 * ambiguous binding that an R2/R3 call depends on — through data OR control flow — blocks.
 */

export interface PlanningDeps {
  execution: ExecutionClient;
  llm: LlmClient;
  /** Pinned planner model id (recorded with every program for M7 replay). */
  model: string;
  source: 'planner' | 'dev_planner';
  /** USD per million tokens, for the run's cost ledger. */
  pricePerMTok?: { input: number; output: number };
}

export type PlanOutcome =
  | {
      ok: true;
      program: Program;
      digest: string;
      source: 'planner' | 'spec' | 'dev_planner';
      attempts: number;
      modelId: string;
      costCents: number;
      rows: PlanRow[];
      validation: ValidationView;
      blocking: Ambiguity[];
      assumptions: Array<{ binding: string; reversibility: string; toolId: string }>;
    }
  | { ok: false; reason: string; attempts: Array<{ raw?: string; errors: Array<{ code: string; message: string }> }>; costCents: number };

/** Same digest as the interpreter's programDigest: the program M7 replays is the one recorded here. */
export const digestOf = (p: Program) => `sha256:${createHash('sha256').update(canonicalJson(p)).digest('hex')}`;

/** Names bound before the program runs, with their taint. */
export function inputTaints(run: Pick<LoadedRun, 'objective' | 'checkpoint'>): Record<string, TaintLevel> {
  const out: Record<string, TaintLevel> = {};
  for (const e of run.objective.entities) out[e.binding] = 'TRUSTED';
  if (run.checkpoint.triggerPayload !== undefined) out['trigger_payload'] = 'UNTRUSTED';
  return out;
}

export async function planRun(
  run: LoadedRun,
  deps: PlanningDeps,
  opts: { committed?: Array<{ toolId: string; summary: string }>; feedback?: Array<{ code: string; message: string }> } = {},
): Promise<PlanOutcome> {
  const spec = run.spec;
  const inputs = inputTaints(run);
  let lastValidation: ValidationView | undefined;

  /** Static validation in the execution plane, plus the bounds the agent spec sets. */
  const check = async (p: Program): Promise<{ valid: boolean; errors: ValidationIssue[] }> => {
    const v = await deps.execution.validateProgram(run.tenantId, p, { inputs, maxCollection: spec.limits.maxFanout });
    lastValidation = v;
    const errors = [...v.errors] as ValidationIssue[];
    for (const c of callsOf(p)) {
      if (!spec.allowedTools.includes(c.tool)) errors.push({ code: 'UNKNOWN_TOOL', message: `${c.tool} is not one of this agent's tools`, nodeId: c.id } as ValidationIssue);
    }
    const bound = callBound(p, spec.limits.maxFanout);
    if (bound > spec.limits.maxSteps) {
      errors.push({ code: 'BOUND_EXCEEDED', message: `the program can make up to ${bound} tool calls; this agent allows ${spec.limits.maxSteps} (max_steps)` } as ValidationIssue);
    }
    return { valid: errors.length === 0, errors };
  };

  let program: Program;
  let source: 'planner' | 'spec' | 'dev_planner';
  let attempts = 1;
  let modelId: string;
  let costCents = 0;

  if (spec.program) {
    // A fixed plan from the agent spec: validated exactly like a generated one.
    source = 'spec';
    modelId = 'spec';
    try {
      program = parse(spec.program);
    } catch (e) {
      return { ok: false, reason: `the agent's program does not parse: ${e instanceof ParseError ? e.message : String(e)}`, attempts: [{ errors: [{ code: 'PARSE', message: String(e) }] }], costCents };
    }
    const v = await check(program);
    if (!v.valid) return { ok: false, reason: "the agent's program is invalid", attempts: [{ errors: v.errors.map((e) => ({ code: e.code, message: e.message })) }], costCents };
  } else {
    source = deps.source;
    modelId = deps.model;
    const [tools, catalog] = await Promise.all([deps.execution.toolDeclarations(run.tenantId, spec.allowedTools), deps.execution.programCatalog()]);
    const plannerTools: PlannerTool[] = tools.map((t) => ({
      toolId: t.toolId,
      title: t.title,
      description: t.description,
      egressClass: t.egressClass,
      reversibility: t.reversibility,
      maxTaint: t.maxTaint,
      outputTaint: t.outputTaint,
      recipientArgs: t.recipientArgs,
      argsSchema: t.argsSchema,
      effectSchema: t.effectSchema,
    }));
    const sources: SourceMetadata[] =
      run.checkpoint.triggerPayload !== undefined
        ? [{ id: `trigger:${run.id}`, taint: 'UNTRUSTED', kind: 'record', binding: 'trigger_payload', ...(Array.isArray(run.checkpoint.triggerPayload) ? { itemCount: run.checkpoint.triggerPayload.length } : {}) }]
        : [];
    const input: PlannerInput = {
      objective: run.objective.objective,
      sources,
      tools: plannerTools,
      schemas: catalog.schemas,
      templates: catalog.templates,
      entities: run.objective.entities.map((e) => ({ binding: e.binding, type: e.type, ...(e.name ? { name: e.name } : {}), ...(e.email ? { email: e.email } : {}) })),
      limits: { maxSteps: spec.limits.maxSteps, maxFanout: spec.limits.maxFanout },
      ...(opts.committed?.length ? { committed: opts.committed.slice(0, 100) } : {}),
      ...(opts.feedback?.length ? { feedback: opts.feedback.slice(0, 50) } : {}),
    };
    try {
      const r = await plan(input, { llm: deps.llm, model: deps.model, validate: check });
      program = r.program;
      attempts = r.attempts;
      modelId = r.model;
      const price = deps.pricePerMTok ?? { input: 15, output: 75 };
      costCents = Math.ceil(((r.usage.inputTokens * price.input + r.usage.outputTokens * price.output) / 1_000_000) * 100);
    } catch (e) {
      if (e instanceof PlanError) {
        const last = e.attempts.at(-1)?.errors[0];
        const reason = last?.code === 'CANNOT_PLAN' ? `the planner cannot plan this: ${last.message}` : `no valid program after ${e.attempts.length} attempt(s): ${last?.message ?? 'invalid'}`;
        return { ok: false, reason, attempts: e.attempts, costCents };
      }
      throw e;
    }
  }

  const validation = lastValidation!;
  const byNode = new Map(validation.calls.map((c) => [c.nodeId, c]));
  const tools = validation.tools ?? {};
  const rows: PlanRow[] = callsOf(program).map((c, i) => ({
    stepIndex: i,
    kind: 'TOOL_CALL',
    dslNodeId: c.id,
    toolId: c.tool,
    plannedReversibility: tools[c.tool]?.reversibility ?? null,
    plannedEgress: tools[c.tool]?.egressClass ?? null,
    plannedTaint: byNode.get(c.id)?.argTaint ?? null,
    plannedDecision: byNode.get(c.id)?.expected ?? null,
    plannedRisk: null, // Module 5
  }));

  // C1's ambiguity policy, now that the plan says what each binding is used for.
  const unresolved = run.objective.ambiguities.filter((a) => !a.resolution);
  const policy = ambiguityPolicy(program, Object.keys(inputs), unresolved.map((a) => a.binding), (id) => tools[id]?.reversibility);
  const blocking: Ambiguity[] = unresolved.filter((a) => policy.blocking.includes(a.binding)).map((a) => ({ ...a, blocking: true }));
  const assumptions = policy.assumptions;

  return { ok: true, program, digest: digestOf(program), source, attempts, modelId, costCents, rows, validation, blocking, assumptions };
}
