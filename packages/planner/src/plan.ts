import type { PlannerInput } from '@vega/contracts';
import { parse, ParseError, ProgramSchema, type Program, type ValidationIssue } from '@vega/dsl';
import type { LlmClient } from '@vega/llm';
import { buildPlannerPrompt } from './prompt.js';

/**
 * Plan → validate → at most ONE re-plan with the structured reason (docs/module3.md §6.3: two
 * consecutive invalid programs abort the run).
 */

export class PlanError extends Error {
  constructor(
    message: string,
    readonly attempts: Array<{ raw: string; errors: Array<{ code: string; message: string }> }>,
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

/** Accepts a ```dsl block (preferred), bare DSL, or a JSON AST. */
export function parsePlannerOutput(raw: string): Program {
  const fenced = /```(?:dsl)?\s*\n([\s\S]*?)```/.exec(raw);
  const body = (fenced ? fenced[1]! : raw).trim();
  if (body.startsWith('{')) {
    const parsed = ProgramSchema.safeParse(JSON.parse(body));
    if (!parsed.success) throw new ParseError(`not a program AST: ${parsed.error.issues[0]?.message ?? 'invalid'}`, 1, 1);
    return parsed.data as Program;
  }
  return parse(body);
}

export interface PlanOptions {
  llm: LlmClient;
  model: string;
  /** Static validation (the interpreter's validator bound to this tenant's declarations). */
  validate: (p: Program) => { valid: boolean; errors: ValidationIssue[] };
  maxAttempts?: number;
}

export async function plan(input: PlannerInput, opts: PlanOptions): Promise<{ program: Program; attempts: number; raw: string }> {
  const attempts: Array<{ raw: string; errors: Array<{ code: string; message: string }> }> = [];
  const max = Math.min(opts.maxAttempts ?? 2, 2);
  let feedback: PlannerInput['feedback'];
  for (let i = 0; i < max; i++) {
    const prompt = buildPlannerPrompt({ ...input, ...(feedback ? { feedback } : {}) });
    const res = await opts.llm.complete({ model: opts.model, system: prompt.system, messages: [{ role: 'user', content: prompt.user }], maxTokens: 4_000, temperature: 0 });
    let program: Program;
    try {
      program = parsePlannerOutput(res.text);
    } catch (e) {
      const errors = [{ code: 'PARSE', message: e instanceof Error ? e.message : 'unparseable' }];
      attempts.push({ raw: res.text, errors });
      feedback = errors;
      continue;
    }
    const v = opts.validate(program);
    if (v.valid) return { program, attempts: i + 1, raw: res.text };
    const errors = v.errors.map((e) => ({ code: e.code, message: e.message, ...(e.nodeId ? { nodeId: e.nodeId } : {}) }));
    attempts.push({ raw: res.text, errors });
    feedback = errors;
  }
  throw new PlanError('the planner produced no valid program within the attempt budget', attempts);
}

/** Program-validity measurement (docs/module3.md §15): M4 starts with a measurable target. */
export async function measureValidity(
  cases: PlannerInput[],
  opts: PlanOptions,
): Promise<{ total: number; firstTry: number; afterReplan: number; failed: number; rate: number }> {
  let firstTry = 0;
  let afterReplan = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      const r = await plan(c, opts);
      if (r.attempts === 1) firstTry++;
      else afterReplan++;
    } catch {
      failed++;
    }
  }
  return { total: cases.length, firstTry, afterReplan, failed, rate: cases.length ? (firstTry + afterReplan) / cases.length : 1 };
}
