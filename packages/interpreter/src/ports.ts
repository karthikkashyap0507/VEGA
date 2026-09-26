import type { Taint } from '@vega/taint';
import type { ToolDeclarationRecord, ToolResult } from '@vega/contracts';

/**
 * Everything the interpreter touches is behind a port, so the same evaluator runs against the
 * connector runtime in the execution plane, against simulate() for dry runs, against recorded
 * results for M7's replay, and against in-memory fakes in the soundness and red-team suites.
 */

export interface ToolInvocation {
  tenantId: string;
  runId: string;
  nodeId: string;
  toolId: string;
  args: Record<string, unknown>;
  mode: 'execute' | 'simulate';
  /**
   * What the gate concluded, for ports that run the Module 4 hook chain. Present on every call
   * the interpreter makes; the gate has already refused violations before a port sees a call.
   */
  declaration?: ToolDeclarationRecord;
  gate?: {
    decision: 'PROCEED' | 'REQUIRE_APPROVAL';
    reason?: string;
    argTaint: Taint;
    argTaints: Array<{ path: string; taint: Taint; dataTaint: Taint; sourceIds: readonly string[] }>;
  };
}

export interface ToolPort {
  invoke(input: ToolInvocation): Promise<ToolResult<unknown>>;
}

export interface DeclarationPort {
  get(tenantId: string, toolId: string): Promise<ToolDeclarationRecord | undefined>;
}

/**
 * The quarantined extractor (services/extractor): untrusted content in, a value of the named
 * schema out. It has no tools and no egress; the interpreter validates what it returns
 * regardless — a schema violation is a security event, not a retry.
 */
export interface ExtractorPort {
  extract(input: { content: unknown; schema: string; jsonSchema: Record<string, unknown>; purpose: string }): Promise<unknown>;
}

export interface Entity {
  kind: 'user' | 'contact';
  id: string;
  email: string;
  displayName: string | null;
}

/** Registries the TENANT controls. Looking a key up can only select an entity already trusted. */
export interface EntityPort {
  lookup(tenantId: string, registry: 'directory' | 'contacts', key: string): Promise<Entity | null>;
}

export interface SourceRecord {
  tenantId: string;
  runId: string;
  uri: string;
  taint: Taint;
  digest: string;
  connectorId?: string | undefined;
  meta: Record<string, unknown>;
}

export interface DerivationRecord {
  tenantId: string;
  runId: string;
  valueRef: string;
  op: string;
  sourceIds: readonly string[];
  taint: Taint;
  dataTaint: Taint;
  /** The control-flow context the value was produced in (implicit-flow audit). */
  contextTaint: Taint;
  /** Parent values — the edges of the provenance graph. */
  inputRefs: readonly string[];
  stepIndex: number;
  nodeId?: string | undefined;
}

export type ViolationKind = 'RECIPIENT' | 'CEILING' | 'PROVENANCE' | 'SCHEMA';

export interface ViolationRecord {
  tenantId: string;
  runId: string;
  nodeId: string | null;
  toolId: string;
  kind: ViolationKind;
  attemptedTaint: Taint;
  declaredMax: Taint;
  argPath: string;
  sourceIds: readonly string[];
  programRef: string;
  severity: 'HIGH' | 'CRITICAL';
  detail: string;
}

export interface ProgramRecord {
  tenantId: string;
  runId: string;
  ast: unknown;
  digest: string;
  modelId: string;
  valid: boolean;
  validationErrors: unknown;
}

export interface Recorder {
  program(p: ProgramRecord): Promise<void>;
  source(s: SourceRecord): Promise<void>;
  derivation(d: DerivationRecord): Promise<void>;
  /** Returns false if the violation was already recorded (replay): the caller must not page again. */
  violation(v: ViolationRecord): Promise<void | boolean>;
}

/** Taint violations PAGE (docs/module3.md §4): they are incidents, not errors. */
export interface Pager {
  page(v: ViolationRecord): Promise<void>;
}

/** Module 5 plugs in here: taint is an INPUT to risk, the gate has already run. */
export interface PolicyPort {
  evaluate(input: {
    tenantId: string;
    runId: string;
    nodeId: string;
    tool: ToolDeclarationRecord;
    argTaint: Taint;
    taintPressure: number;
    args: Record<string, unknown>;
  }): Promise<{ decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY'; reason?: string }>;
}
