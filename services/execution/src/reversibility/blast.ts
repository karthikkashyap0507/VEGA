import type { ToolResult } from '@vega/contracts';
import { blastRadius, type BlastRadiusSummary, type PlannedEffect } from '@vega/compensators';
import type { Program } from '@vega/dsl';
import { Interpreter, type DeclarationPort, type EntityPort, type ExtractorPort, type Recorder, type RunContext, type SchemaRegistry, type ToolPort } from '@vega/interpreter';
import type { ToolInvoker } from '../executor/pass.js';

/**
 * THE BLAST RADIUS OF A PROGRAM — docs/module6.md §5.6. The interpreter runs the program in
 * `simulate` mode: reads execute (a plan over empty reads shows nothing), every other call is
 * simulate()d — through the same gate, with the same taint rules — and each call's full effect
 * is kept. Nothing consequential happens; nothing is journaled or recorded as provenance (the
 * real run records its own).
 */

const quiet: Recorder = { program: async () => undefined, source: async () => undefined, derivation: async () => undefined, violation: async () => false };

export interface BlastDeps {
  invoker: ToolInvoker;
  declarations: DeclarationPort;
  extractor: ExtractorPort;
  entities: EntityPort;
  schemas: SchemaRegistry;
}

export async function programBlastRadius(
  deps: BlastDeps,
  input: { tenantId: string; runId: string; bindings: Record<string, string>; program: Program; modelId: string; now: string; inputs: RunContext['inputs']; maxCollection?: number | undefined },
): Promise<{ effects: PlannedEffect[]; summary: BlastRadiusSummary; status: string }> {
  const planned: PlannedEffect[] = [];
  const tools: ToolPort = {
    async invoke(inv) {
      const decl = inv.declaration ?? (await deps.declarations.get(inv.tenantId, inv.toolId));
      const key = inv.toolId.startsWith('mcp.') ? inv.toolId.split('.').slice(0, 2).join('.') : decl?.connectorKind;
      const connectorId = key ? input.bindings[key] : undefined;
      let r: ToolResult<unknown>;
      if (!connectorId) r = { ok: false, error: { code: 'CONNECTOR_UNAVAILABLE', message: `no ${key ?? 'connector'} bound to this run` } };
      else {
        const call = { tenantId: inv.tenantId, connectorId, toolId: inv.toolId, args: inv.args, runId: inv.runId, nodeId: `blast.${inv.nodeId}` };
        r = inv.mode === 'simulate' ? await deps.invoker.simulate(call) : await deps.invoker.execute(call);
      }
      if (decl) planned.push({ nodeId: inv.nodeId, toolId: inv.toolId, reversibility: decl.reversibility, holdSupported: decl.holdSupported, effect: r.ok ? r.effect : null, error: r.ok ? undefined : `${r.error.code}: ${r.error.message}` });
      return r;
    },
  };
  const interp = new Interpreter({ tools, declarations: deps.declarations, extractor: deps.extractor, entities: deps.entities, recorder: quiet, schemas: deps.schemas });
  const result = await interp.run(input.program, {
    tenantId: input.tenantId,
    runId: input.runId,
    modelId: input.modelId,
    mode: 'simulate',
    now: input.now,
    ...(input.inputs ? { inputs: input.inputs } : {}),
    ...(input.maxCollection ? { maxCollection: input.maxCollection } : {}),
  });
  return { effects: planned, summary: blastRadius(planned), status: result.status };
}
