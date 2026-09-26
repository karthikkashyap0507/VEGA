import { z } from 'zod';
import { ToolDeclarationRecord } from '@vega/contracts';
import type { AnyTool, ToolDeclaration } from './connector.js';

/**
 * Registers a tool's declaration. INVARIANT 4 (PROJECT.md §10.2): "No tool registers without
 * a complete declaration." Three layers enforce it:
 *   1. the type — CompensatorRequirement makes R1/R2 without a compensator a compile error
 *   2. `require-tool-declaration` — every defineTool() call has every key, literally
 *   3. this function — the same rules at runtime, so a declaration assembled dynamically (an
 *      MCP server's tools) meets the identical bar
 * The database CHECK on tool_declarations is a fourth.
 */
export class DeclarationError extends Error {
  constructor(
    readonly toolId: string,
    readonly problems: string[],
  ) {
    super(`tool "${toolId}" has an invalid declaration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'DeclarationError';
  }
}

export function defineTool<A extends z.ZodType, E extends z.ZodType>(decl: ToolDeclaration<A, E>): ToolDeclaration<A, E> {
  const problems = validateDeclaration(decl);
  if (problems.length) throw new DeclarationError(decl.toolId, problems);
  return Object.freeze(decl);
}

/**
 * For declarations that are DATA, not code — MCP tools discovered at runtime and declared by
 * an admin. Same validation as defineTool; what it loses is the build-time check, which is
 * why the lint rule allows this factory only in packages/connectors/mcp (and why MCP tools
 * start from the most conservative declaration there is).
 */
export function defineRuntimeTool(decl: AnyTool): AnyTool {
  const problems = validateDeclaration(decl);
  if (problems.length) throw new DeclarationError(decl.toolId, problems);
  return Object.freeze(decl);
}

export function validateDeclaration(decl: AnyTool): string[] {
  const problems: string[] = [];
  const parsed = ToolDeclarationRecord.safeParse(toRecord(decl, { skipSchemas: true }));
  if (!parsed.success) {
    for (const i of parsed.error.issues) problems.push(`${i.path.join('.')}: ${i.message}`);
  }
  if (!decl.toolId.startsWith(`${decl.connectorKind}.`)) {
    problems.push(`toolId must start with its connector kind "${decl.connectorKind}."`);
  }
  // Checked on the loosely-typed view: the type system already forbids these combinations,
  // this catches declarations assembled at runtime (MCP) where the types cannot help.
  const loose = decl as { reversibility: string; compensatorRef?: string };
  if ((loose.reversibility === 'R1' || loose.reversibility === 'R2') && !loose.compensatorRef) {
    problems.push(`${loose.reversibility} requires a compensatorRef (PROJECT.md §7.5)`);
  }
  if ((loose.reversibility === 'R0' || loose.reversibility === 'R3') && loose.compensatorRef) {
    problems.push(`${loose.reversibility} must not declare a compensator: there is nothing to undo, or undo is impossible`);
  }
  if (decl.reversibility === 'R0' && decl.egressClass !== 'INTERNAL' && decl.egressClass !== 'PUBLIC') {
    problems.push('an R0 (read-only) tool cannot have EXTERNAL egress');
  }
  if (decl.holdSupported && decl.reversibility === 'R0') {
    problems.push('holding a read is meaningless: holdSupported must be false for R0');
  }
  for (const arg of decl.recipientArgs) {
    if (!resolvesToArg(decl.argsSchema, arg)) problems.push(`recipientArgs names "${arg}", which is not an argument`);
  }
  if (typeof decl.simulate !== 'function' || typeof decl.execute !== 'function') {
    problems.push('simulate() and execute() are both required');
  }
  return problems;
}

/** Follows a dotted path (e.g. `patch.attendees`) through nested object schemas. */
function resolvesToArg(schema: z.ZodType, path: string): boolean {
  let current: unknown = schema;
  for (const segment of path.split('.')) {
    let node = current as { shape?: Record<string, unknown>; unwrap?: () => unknown; def?: { innerType?: unknown; in?: unknown } };
    // Unwrap optional/default/effects wrappers to reach the object shape.
    for (let i = 0; i < 5 && !node?.shape; i++) {
      const inner = node?.def?.innerType ?? node?.def?.in ?? (typeof node?.unwrap === 'function' ? node.unwrap() : undefined);
      if (!inner) break;
      node = inner as typeof node;
    }
    if (!node?.shape || !(segment in node.shape)) return false;
    current = node.shape[segment];
  }
  return true;
}

const jsonSchema = (s: z.ZodType) =>
  z.toJSONSchema(s, { target: 'draft-2020-12', unrepresentable: 'any' }) as Record<string, unknown>;

/** The serializable projection stored in tool_declarations and shown to compliance officers. */
export function toRecord(decl: AnyTool, opts: { skipSchemas?: boolean } = {}): ToolDeclarationRecord {
  return {
    toolId: decl.toolId,
    connectorKind: decl.connectorKind,
    version: decl.version,
    title: decl.title,
    description: decl.description,
    scopes: [...decl.scopes],
    egressClass: decl.egressClass,
    reversibility: decl.reversibility,
    maxTaint: decl.maxTaint,
    idempotency: decl.idempotency,
    sensitivityHint: decl.sensitivityHint,
    holdSupported: decl.holdSupported,
    simulateFidelity: decl.simulateFidelity,
    compensatorRef: decl.compensatorRef ?? null,
    outputTaint: decl.outputTaint,
    recipientArgs: [...decl.recipientArgs],
    argsSchema: opts.skipSchemas ? {} : jsonSchema(decl.argsSchema),
    effectSchema: opts.skipSchemas ? {} : jsonSchema(decl.effectSchema),
    costHint: decl.costHint ?? null,
  };
}
