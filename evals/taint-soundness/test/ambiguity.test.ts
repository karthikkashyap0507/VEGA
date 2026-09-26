import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolDeclarationRecord } from '@vega/contracts';
import { ambiguityPolicy } from '@vega/dsl';
import { evaluate, MemoryEntities, MemoryRecorder, SchemaRegistry } from '@vega/interpreter';
import { AdversarialExtractor, RecordingTools, StaticDeclarations } from '@vega/interpreter/testing';
import { canonicalJson } from '@vega/taint';
import { generate, syntheticTools } from '../src/generate.js';

/**
 * AMBIGUITY ZERO TOLERANCE — docs/module4.md §11: "no R2/R3 proceeds with unresolved
 * ambiguity" is BLOCKING with zero tolerance, so it is proved over random programs rather than
 * spot-checked.
 *
 * The oracle is the interpreter itself: run the program twice, the ambiguous input bound to two
 * different candidates. If any irreversible call differs between the runs — in its arguments,
 * or in whether it happens at all — the binding influenced it, and the static policy (the one
 * C2 applies before anything executes) must have blocked. A single counterexample is a way for
 * an unresolved guess to reach an irreversible action.
 */

// The synthetic tools, with every reversibility class represented.
const tools: ToolDeclarationRecord[] = syntheticTools().map((t, i) => ({ ...t, reversibility: t.egressClass === 'INTERNAL' ? (i % 2 ? 'R1' : 'R0') : i % 2 ? 'R2' : 'R3' }));
const decls = new Map(tools.map((t) => [t.toolId, t]));
const rev = (id: string) => decls.get(id)?.reversibility;
const IRREVERSIBLE = new Set(tools.filter((t) => t.reversibility === 'R2' || t.reversibility === 'R3').map((t) => t.toolId));
const RUNS = Number(process.env['SOUNDNESS_RUNS'] ?? 300);

const schemas = new SchemaRegistry().register('Blob', z.unknown());
const entities = new MemoryEntities({
  directory: [
    { kind: 'user', id: 'u1', email: 'sam.lee@acme.example', displayName: 'Sam Lee' },
    { kind: 'user', id: 'u2', email: 'sam.park@acme.example', displayName: 'Sam Park' },
  ],
  contacts: [],
});

async function irreversibleCalls(seed: number, size: number, candidate: unknown): Promise<string[]> {
  const g = generate(seed, size, ['TRUSTED', 'TRUSTED']);
  const recording = new RecordingTools();
  await evaluate(
    { tools: recording, declarations: new StaticDeclarations(tools), extractor: new AdversarialExtractor((_s, c) => c), entities, recorder: new MemoryRecorder(), schemas },
    g.program,
    // simulate: approvals never halt the run, so every reachable call is observed
    { tenantId: 't', runId: 'r', modelId: 'm', mode: 'simulate', now: '2026-01-01T00:00:00Z', stepLimit: 5_000, inputs: { ...g.inputs, in0: { data: candidate, taint: 'TRUSTED' } } },
    decls,
  );
  return recording.executed.filter((c) => IRREVERSIBLE.has(c.toolId)).map((c) => canonicalJson([c.nodeId, c.toolId, c.args]));
}

describe('C1 ambiguity policy (property-based, zero tolerance)', () => {
  it('ZERO TOLERANCE: whenever the ambiguous binding can change an R2/R3 call, the plan is blocked', async () => {
    let influenced = 0;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.integer({ min: 1, max: 8 }), async (seed, size) => {
        const g = generate(seed, size, ['TRUSTED', 'TRUSTED']);
        const policy = ambiguityPolicy(g.program, ['in0', 'in1'], ['in0'], rev);
        // Candidates that differ in shape AND truthiness, so a branch on the binding flips too.
        const runs = await Promise.all(
          [{ email: 'sam.lee@acme.example', name: 'Sam Lee' }, 'sam.park@acme.example', '', null, 0].map((c) => irreversibleCalls(seed, size, c)),
        );
        const differs = new Set(runs.map((r) => canonicalJson(r))).size > 1;
        if (differs) influenced++;
        if (differs) expect(policy.blocking, `an irreversible call changed with the guess yet the plan was not blocked (seed ${seed}, size ${size})`).toContain('in0');
      }),
      { numRuns: RUNS },
    );
    // The property is only meaningful if the generator reaches the interesting case often.
    expect(influenced).toBeGreaterThan(RUNS / 20);
  });

  it('PRECISION: a binding no call depends on never blocks and records no assumption', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.integer({ min: 1, max: 8 }), (seed, size) => {
        const g = generate(seed, size, ['TRUSTED', 'TRUSTED']);
        const policy = ambiguityPolicy(g.program, ['in0', 'in1', 'unused'], ['unused'], rev);
        expect(policy.blocking).toEqual([]);
        expect(policy.assumptions).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});
