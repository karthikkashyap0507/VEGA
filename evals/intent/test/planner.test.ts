import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PlannerInput } from '@vega/contracts';
import { launchRegistry } from '@vega/connectors';
import { callBound, validate } from '@vega/dsl';
import { hasTemplate, SchemaRegistry } from '@vega/interpreter';
import { AnthropicClient, type LlmClient } from '@vega/llm';
import { DevPlannerModel, measureValidity } from '@vega/planner';

/**
 * C2 PROGRAM VALIDITY — docs/module4.md §11: "≥ 90% first attempt" through M3's harness. This
 * run measures the development planner behind the real pipeline (metadata prompt → parse →
 * static validation + bounds → one replan). The same harness measures the planner MODEL when a
 * key is configured (PLANNER_EVAL_MODEL) — that number is the product's; this one keeps the
 * pipeline and the development stand-in honest.
 */

const here = dirname(fileURLToPath(import.meta.url));
// PLANNER_EVAL_MODEL + a key → measure the model; otherwise the development planner.
const key = process.env['LITELLM_MASTER_KEY'] || process.env['ANTHROPIC_API_KEY'];
const liveModel = key ? process.env['PLANNER_EVAL_MODEL'] : undefined;
const llm: LlmClient = liveModel ? new AnthropicClient({ apiKey: key!, ...(process.env['LITELLM_MASTER_KEY'] && process.env['LITELLM_BASE_URL'] ? { baseUrl: process.env['LITELLM_BASE_URL'] } : {}) }) : new DevPlannerModel();
const model = liveModel ?? 'dev-planner';
const registry = launchRegistry();
const records = registry.records().filter((r) => ['gmail', 'gcal', 'slack'].includes(r.connectorKind));
const decls = new Map(records.map((r) => [r.toolId, r]));
const schemas = new SchemaRegistry();
const entity = (binding: string, name: string, email: string) => ({ binding, type: 'person', name, email });

const base = (objective: string, entities: PlannerInput['entities'] = []): PlannerInput => ({
  objective,
  sources: [],
  tools: records.map((t) => ({ toolId: t.toolId, title: t.title, description: t.description, egressClass: t.egressClass, reversibility: t.reversibility, maxTaint: t.maxTaint, outputTaint: t.outputTaint, recipientArgs: t.recipientArgs, argsSchema: t.argsSchema, effectSchema: t.effectSchema })),
  schemas: schemas.describe(),
  templates: ['meeting-offer', 'reply', 'summary', 'plain'],
  entities,
  limits: { maxSteps: 20, maxFanout: 5 },
});

const CASES: PlannerInput[] = [
  base('Email Peter saying the quarterly numbers are attached', [entity('peter', 'Peter Quill', 'peter@partner.example')]),
  base('Draft an email to Alice saying the deck is ready', [entity('alice', 'Alice Nguyen', 'alice@us.example')]),
  base('Schedule a meeting with Bob on 2026-10-05 at 14:00 for 45 minutes', [entity('bob', 'Bob Stone', 'bob@us.example')]),
  base('Book a call with Ivy on 2026-11-02 at 09:30', [entity('ivy', 'Ivy Chen', 'ivy@client.example')]),
  base('Summarize my emails about "renewal"'),
  base('Check my inbox for "invoice"'),
  base('Handle the meeting request from the client'),
  base('Reply to the latest meeting request'),
  base('Post in #general saying standup moved to 10:15'),
  base('Send Grace a message saying the slides are uploaded', [entity('grace', 'Grace Hopper', 'grace@cobol.example')]),
];

describe('C2 program validity (eval)', () => {
  it('≥ 90% valid on the first attempt, bounds included', async () => {
    const r = await measureValidity(CASES, {
      llm,
      model,
      validate: (p) => {
        const inputs = { now: { taint: 'TRUSTED' as const, dataTaint: 'TRUSTED' as const }, objective: { taint: 'TRUSTED' as const, dataTaint: 'TRUSTED' as const }, peter: { taint: 'TRUSTED' as const, dataTaint: 'TRUSTED' as const }, alice: { taint: 'TRUSTED' as const, dataTaint: 'TRUSTED' as const }, bob: { taint: 'TRUSTED' as const, dataTaint: 'TRUSTED' as const }, ivy: { taint: 'TRUSTED' as const, dataTaint: 'TRUSTED' as const }, grace: { taint: 'TRUSTED' as const, dataTaint: 'TRUSTED' as const } };
        const v = validate(p, { tool: (id) => decls.get(id), hasSchema: (n) => schemas.has(n), hasTemplate, maxCollection: 5, inputs });
        const errors = [...v.errors];
        if (callBound(p, 5) > 20) errors.push({ code: 'BOUND_EXCEEDED', message: 'max_steps' } as (typeof errors)[number]);
        return { valid: errors.length === 0, errors };
      },
    });
    writeFileSync(join(here, '..', 'planner-report.json'), JSON.stringify({ planner: model, ...r }, null, 2));
    expect(r.firstTry / r.total).toBeGreaterThanOrEqual(0.9);
  });
});
