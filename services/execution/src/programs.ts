import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ToolDeclarationRecord } from '@vega/contracts';
import { toRecord, type ConnectorRuntime, type ToolRegistry } from '@vega/connector-sdk';
import { callsOf, parse, ParseError, ProgramSchema, validate, type Program } from '@vega/dsl';
import {
  hasTemplate,
  Interpreter,
  PgRecorder,
  SchemaRegistry,
  type DeclarationPort,
  type EntityPort,
  type ExtractorPort,
  type Pager,
  type RunResult,
  type ToolPort,
} from '@vega/interpreter';

/**
 * Execution-plane program API — docs/module3.md §3, §7. The interpreter runs HERE, next to the
 * connector runtime and the gate; the control plane (dry runs, validation) and, from Module 4,
 * the orchestrator call it. Nothing here is reachable from the public gateway.
 */

/** Declarations for the gate: compiled-in tools plus this tenant's MCP tools. */
export class RuntimeDeclarations implements DeclarationPort {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly runtime: ConnectorRuntime,
  ) {}
  async get(tenantId: string, toolId: string): Promise<ToolDeclarationRecord | undefined> {
    const found = this.registry.get(toolId);
    if (found) return toRecord(found.tool);
    const dyn = await this.runtime.describe(tenantId, toolId);
    return dyn ? toRecord(dyn) : undefined;
  }
}

/**
 * Tool calls go to the connector runtime (M2), bound to the connectors the run was given:
 * `bindings` maps a connector kind — or `mcp.<server>` — to a connector id in the tenant.
 */
export class RuntimeTools implements ToolPort {
  constructor(
    private readonly runtime: ConnectorRuntime,
    private readonly declarations: DeclarationPort,
    private readonly bindings: Record<string, string>,
  ) {}
  async invoke(input: { tenantId: string; runId: string; nodeId: string; toolId: string; args: Record<string, unknown>; mode: 'execute' | 'simulate' }) {
    const decl = await this.declarations.get(input.tenantId, input.toolId);
    const key = input.toolId.startsWith('mcp.') ? input.toolId.split('.').slice(0, 2).join('.') : decl?.connectorKind;
    const connectorId = key ? this.bindings[key] : undefined;
    if (!connectorId) return { ok: false as const, error: { code: 'CONNECTOR_UNAVAILABLE' as const, message: `no ${key ?? 'connector'} bound to this run` } };
    const call = { tenantId: input.tenantId, connectorId, toolId: input.toolId, args: input.args, runId: input.runId, nodeId: input.nodeId };
    return input.mode === 'simulate' ? this.runtime.simulate(call) : this.runtime.execute(call);
  }
}

const ProgramInput = z.union([z.string().min(1).max(200_000), ProgramSchema]);

function toProgram(p: z.infer<typeof ProgramInput>): Program {
  return typeof p === 'string' ? parse(p) : (p as Program);
}

export function serializeRun(r: RunResult) {
  return {
    status: r.status,
    programDigest: r.programDigest,
    traceDigest: r.traceDigest,
    steps: r.steps,
    emits: r.emits.map((e) => ({ data: e.data, taint: e.taint, dataTaint: e.dataTaint, sourceIds: e.sourceIds, valueRef: e.valueRef })),
    calls: r.calls,
    ...(r.validationErrors ? { validationErrors: r.validationErrors } : {}),
    ...(r.violation ? { violation: r.violation } : {}),
    ...(r.pending ? { pending: r.pending } : {}),
    ...(r.error ? { error: r.error } : {}),
  };
}

export interface ProgramApiDeps {
  runtime: ConnectorRuntime;
  registry: ToolRegistry;
  extractor: ExtractorPort;
  entities: EntityPort;
  pager?: Pager;
}

export function registerProgramApi(app: FastifyInstance, deps: ProgramApiDeps): void {
  const declarations = new RuntimeDeclarations(deps.registry, deps.runtime);
  const schemas = new SchemaRegistry();

  const RunBody = z.object({
    tenantId: z.string().uuid(),
    runId: z.string().min(1).max(200),
    program: ProgramInput,
    mode: z.enum(['execute', 'simulate']),
    modelId: z.string().min(1).max(200),
    now: z.string().datetime({ offset: true }),
    bindings: z.record(z.string(), z.string().uuid()).default({}),
    approvedNodes: z.array(z.string()).max(500).default([]),
    objective: z.string().max(4000).optional(),
  });

  app.post('/internal/programs/run', async (req, reply) => {
    const input = RunBody.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.error.message } });
    let program: Program;
    try {
      program = toProgram(input.data.program);
    } catch (e) {
      return reply.code(400).send({ error: { code: 'PARSE', message: e instanceof ParseError ? e.message : 'unparseable program' } });
    }
    const recorder = new PgRecorder();
    const interpreter = new Interpreter({
      tools: new RuntimeTools(deps.runtime, declarations, input.data.bindings),
      declarations,
      extractor: deps.extractor,
      entities: deps.entities,
      recorder,
      ...(deps.pager ? { pager: deps.pager } : {}),
      schemas,
    });
    const result = await interpreter.run(program, {
      tenantId: input.data.tenantId,
      runId: input.data.runId,
      modelId: input.data.modelId,
      mode: input.data.mode,
      now: input.data.now,
      approvedNodes: new Set(input.data.approvedNodes),
      ...(input.data.objective ? { inputs: { objective: { data: input.data.objective, taint: 'TRUSTED' as const } } } : {}),
    });
    await recorder.flush();
    return serializeRun(result);
  });

  app.post('/internal/programs/validate', async (req, reply) => {
    const input = z.object({ tenantId: z.string().uuid(), program: ProgramInput }).safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION', message: input.error.message } });
    let program: Program;
    try {
      program = toProgram(input.data.program);
    } catch (e) {
      return { valid: false, errors: [{ code: 'PARSE', message: e instanceof ParseError ? e.message : 'unparseable program' }], calls: [] };
    }
    const decls = new Map<string, ToolDeclarationRecord>();
    for (const c of callsOf(program)) {
      const d = await declarations.get(input.data.tenantId, c.tool);
      if (d) decls.set(c.tool, d);
    }
    return { program, ...validate(program, { tool: (id) => decls.get(id), hasSchema: (n) => schemas.has(n), hasTemplate, inputs: { now: { taint: 'TRUSTED', dataTaint: 'TRUSTED' }, objective: { taint: 'TRUSTED', dataTaint: 'TRUSTED' } } }) };
  });

  app.get('/internal/programs/catalog', async () => ({ schemas: schemas.describe(), templates: ['meeting-offer', 'reply', 'summary', 'plain'] }));
}
