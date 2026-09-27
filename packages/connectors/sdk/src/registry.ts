import type { ConnectorKind, ToolDeclarationRecord } from '@vega/contracts';
import { CompensatorError, isHoldOnly, validateCompensator, type AnyCompensator } from './compensator.js';
import type { AnyTool, ConnectorDefinition } from './connector.js';
import { DeclarationError, toRecord, validateDeclaration } from './define.js';

/**
 * The tool registry. A connector registers as a whole; each of its tools is validated again
 * here, so nothing reaches the registry by a path that skipped defineTool().
 *
 * Module 6: a connector registers with its compensators, and every R1/R2 tool's
 * `compensatorRef` must resolve to one of them, for the same tool. An R1 tool needs a real
 * inverse; an R2 tool may name a hold-only one (its undo is the hold window).
 */
export class ToolRegistry {
  private readonly connectors = new Map<ConnectorKind, ConnectorDefinition>();
  private readonly tools = new Map<string, { tool: AnyTool; connector: ConnectorDefinition }>();
  private readonly compensators = new Map<string, AnyCompensator>();

  register(connector: ConnectorDefinition): this {
    if (this.connectors.has(connector.kind)) throw new Error(`connector "${connector.kind}" registered twice`);
    for (const tool of connector.tools) {
      const problems = validateDeclaration(tool);
      if (problems.length) throw new DeclarationError(tool.toolId, problems);
      if (tool.connectorKind !== connector.kind) {
        throw new DeclarationError(tool.toolId, [`declared for "${tool.connectorKind}" but registered under "${connector.kind}"`]);
      }
      if (this.tools.has(tool.toolId)) throw new DeclarationError(tool.toolId, ['toolId registered twice']);
    }
    const own = new Map<string, AnyCompensator>();
    for (const c of connector.compensators ?? []) {
      const problems = validateCompensator(c);
      if (problems.length) throw new CompensatorError(c.ref, problems);
      if (own.has(c.ref) || this.compensators.has(c.ref)) throw new CompensatorError(c.ref, ['registered twice']);
      own.set(c.ref, c);
    }
    for (const tool of connector.tools) {
      if (tool.reversibility !== 'R1' && tool.reversibility !== 'R2') continue;
      const c = own.get(tool.compensatorRef);
      if (!c) throw new DeclarationError(tool.toolId, [`names compensator "${tool.compensatorRef}", which ${connector.kind} does not register`]);
      if (c.toolId !== tool.toolId) throw new DeclarationError(tool.toolId, [`compensator "${c.ref}" is for ${c.toolId}`]);
      if (tool.reversibility === 'R1' && isHoldOnly(c)) throw new DeclarationError(tool.toolId, ['an R1 tool needs a real inverse, not a hold-only compensator']);
    }
    for (const tool of connector.tools) this.tools.set(tool.toolId, { tool, connector });
    for (const [ref, c] of own) this.compensators.set(ref, c);
    this.connectors.set(connector.kind, connector);
    return this;
  }

  /** The compensator a tool names: static, or — for a runtime-declared tool — its connector's. */
  compensatorFor(tool: AnyTool): AnyCompensator | undefined {
    if (!tool.compensatorRef) return undefined;
    const found = this.compensators.get(tool.compensatorRef);
    if (found) return found.toolId === tool.toolId ? found : undefined;
    return this.connectors.get(tool.connectorKind)?.dynamicCompensator?.(tool);
  }

  compensator(ref: string): AnyCompensator | undefined {
    return this.compensators.get(ref);
  }

  allCompensators(): AnyCompensator[] {
    return [...this.compensators.values()];
  }

  connector(kind: ConnectorKind): ConnectorDefinition | undefined {
    return this.connectors.get(kind);
  }

  allConnectors(): ConnectorDefinition[] {
    return [...this.connectors.values()];
  }

  get(toolId: string): { tool: AnyTool; connector: ConnectorDefinition } | undefined {
    return this.tools.get(toolId);
  }

  toolsFor(kind: ConnectorKind): AnyTool[] {
    return this.connectors.get(kind)?.tools ?? [];
  }

  records(filter: { kind?: ConnectorKind } = {}): ToolDeclarationRecord[] {
    return [...this.tools.values()]
      .filter((t) => !filter.kind || t.tool.connectorKind === filter.kind)
      .map((t) => toRecord(t.tool))
      .sort((a, b) => a.toolId.localeCompare(b.toolId));
  }
}
