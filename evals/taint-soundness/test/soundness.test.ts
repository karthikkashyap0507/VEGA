import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolDeclarationRecord } from '@vega/contracts';
import { underRecipient, validate } from '@vega/dsl';
import { evaluate, MemoryEntities, MemoryRecorder, SchemaRegistry, type RunContext, type RunResult } from '@vega/interpreter';
import { AdversarialExtractor, RecordingTools, StaticDeclarations } from '@vega/interpreter/testing';
import { gt, join, leq, type Taint } from '@vega/taint';
import { generate, syntheticTools } from '../src/generate.js';

/**
 * TAINT SOUNDNESS — docs/module3.md §11.2. The six properties, over random programs and random
 * taint assignments, run on the RUNTIME evaluator with static validation bypassed (the gate must
 * hold on its own). A single counterexample proves a class of bypass.
 */

const tools = syntheticTools();
const decls = new Map<string, ToolDeclarationRecord>(tools.map((t) => [t.toolId, t]));
const LEVEL = fc.constantFrom<Taint>('TRUSTED', 'ORG', 'UNTRUSTED');
const RUNS = Number(process.env['SOUNDNESS_RUNS'] ?? 300);

const schemas = new SchemaRegistry().register('Blob', z.unknown());
const entities = new MemoryEntities({
  directory: [{ kind: 'user', id: 'u1', email: 'alice@acme.example', displayName: 'Alice' }],
  contacts: [{ kind: 'contact', id: 'c1', email: 'bob@acme.example', displayName: 'Bob' }],
});

async function execute(seed: number, size: number, taints: Taint[], approveAll = false) {
  const g = generate(seed, size, taints);
  const recorder = new MemoryRecorder();
  const recording = new RecordingTools();
  const ctx: RunContext = {
    tenantId: 't',
    runId: 'r',
    modelId: 'm',
    mode: 'execute',
    now: '2026-01-01T00:00:00Z',
    stepLimit: 5_000,
    inputs: g.inputs,
    ...(approveAll ? { approvedNodes: new Set(Array.from({ length: 200 }, (_, i) => `n${i + 1}`)) } : {}),
  };
  const result: RunResult = await evaluate(
    { tools: recording, declarations: new StaticDeclarations(tools), extractor: new AdversarialExtractor((_s, c) => c), entities, recorder, schemas },
    g.program,
    ctx,
    decls,
  );
  return { g, recorder, recording, result };
}

const prop = (f: (seed: number, size: number, taints: Taint[]) => Promise<void>) =>
  fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), fc.integer({ min: 1, max: 8 }), fc.array(LEVEL, { minLength: 1, maxLength: 4 }), f), { numRuns: RUNS });

describe('taint soundness (property-based)', () => {
  it('SOUNDNESS: no executed call exceeds its ceiling without a gate decision, and no recipient is ever untrusted data', async () => {
    await prop(async (seed, size, taints) => {
      for (const approveAll of [false, true]) {
        const { result, recording } = await execute(seed, size, taints, approveAll);
        for (const c of result.calls) {
          const d = decls.get(c.toolId)!;
          const executed = recording.executed.some((e) => e.nodeId === c.nodeId);
          if (!executed) continue;
          for (const leaf of c.argTaints) {
            if (d.recipientArgs.some((r) => underRecipient(leaf.path, r))) expect(leaf.dataTaint, `${c.toolId} ${leaf.path}`).toBe('TRUSTED');
          }
          const agg = join(...c.argTaints.map((l) => l.taint));
          if (gt(agg, d.maxTaint)) {
            expect(c.gate, `${c.toolId} executed over its ceiling`).toBe('REQUIRE_APPROVAL');
            expect(d.egressClass).not.toBe('INTERNAL');
            expect(approveAll).toBe(true);
          } else {
            expect(c.gate).not.toBe('VIOLATION');
          }
        }
      }
    });
  });

  it('MONOTONICITY: raising any input taint never lowers any output taint', async () => {
    await prop(async (seed, size, taints) => {
      const raised = taints.map((t, i) => (i === seed % taints.length ? 'UNTRUSTED' : t));
      const a = await execute(seed, size, taints, true);
      const b = await execute(seed, size, raised, true);
      const byRef = new Map(b.recorder.derivations.map((d) => [`${d.valueRef}|${d.op}`, d]));
      // Control flow is data-dependent, not taint-dependent, so the runs align until one halts.
      for (const d of a.recorder.derivations) {
        const other = byRef.get(`${d.valueRef}|${d.op}`);
        if (other) {
          expect(leq(d.taint, other.taint), `${d.op} ${d.valueRef}`).toBe(true);
          expect(leq(d.dataTaint, other.dataTaint)).toBe(true);
        }
      }
    });
  });

  it('NO LAUNDERING: every operation’s output is ⊒ the join of its inputs (dataTaint lowers only via resolve)', async () => {
    await prop(async (seed, size, taints) => {
      const { recorder } = await execute(seed, size, taints, true);
      const byRef = new Map(recorder.derivations.map((d) => [d.valueRef, d]));
      for (const d of recorder.derivations) {
        const inputs = d.inputRefs.map((r) => byRef.get(r)!).filter(Boolean);
        expect(leq(join(...inputs.map((i) => i.taint)), d.taint), `${d.op} laundered taint`).toBe(true);
        if (d.op !== 'resolve') expect(leq(join(...inputs.map((i) => i.dataTaint)), d.dataTaint), `${d.op} laundered dataTaint`).toBe(true);
        else expect(d.dataTaint).toBe('TRUSTED');
        expect(leq(d.dataTaint, d.taint)).toBe(true);
      }
    });
  });

  it('IMPLICIT FLOW: values produced inside a branch are ⊒ the branch condition', async () => {
    await prop(async (seed, size, taints) => {
      const { recorder } = await execute(seed, size, taints, true);
      for (const d of recorder.derivations) expect(leq(d.contextTaint, d.taint), `${d.op} ${d.valueRef}`).toBe(true);
    });
  });

  it('AGREEMENT: every gated call carries exactly the taint static inference predicts (an independent implementation of §5.2)', async () => {
    await prop(async (seed, size, taints) => {
      const { g, result } = await execute(seed, size, taints, true);
      const stat = validate(g.program, {
        tool: (id) => decls.get(id),
        hasSchema: () => true,
        hasTemplate: () => true,
        inputs: Object.fromEntries(Object.entries(g.inputs).map(([k, v]) => [k, { taint: v.taint, dataTaint: v.taint }])),
      });
      const byNode = new Map(stat.calls.map((c) => [c.nodeId, c]));
      for (const c of result.calls) {
        const s = byNode.get(c.nodeId)!;
        // Generated collections are never empty, so static inference is exact here.
        expect(join(...c.argTaints.map((l) => l.taint), s.contextTaint), `${c.toolId} ${c.nodeId} argTaint`).toBe(s.argTaint);
        for (const r of s.recipients) {
          expect(c.argTaints.find((l) => l.path === r.path)?.dataTaint, `${c.nodeId} ${r.path}`).toBe(r.dataTaint);
        }
      }
    });
  });

  it('DETERMINISM: same program + same inputs → identical derivation trace', async () => {
    await prop(async (seed, size, taints) => {
      const a = await execute(seed, size, taints, true);
      const b = await execute(seed, size, taints, true);
      expect(a.result.traceDigest).toBe(b.result.traceDigest);
      expect(a.result.status).toBe(b.result.status);
    });
  });

  it('TERMINATION: every program halts within the step limit', async () => {
    await prop(async (seed, size, taints) => {
      const { result } = await execute(seed, size, taints, true);
      expect(result.steps).toBeLessThanOrEqual(5_000);
      expect(['completed', 'violated', 'failed', 'awaiting_approval']).toContain(result.status);
    });
  });
});
