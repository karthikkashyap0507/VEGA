import type { z } from 'zod';
import type {
  CompensatorRequirement,
  ConnectorKind,
  EgressClass,
  Effect,
  Idempotency,
  SimulationFidelity,
  TaintLevel,
} from '@vega/contracts';
import type { AnyCompensator } from './compensator.js';
import type { ProviderHttp } from './http.js';

/**
 * What a tool receives when it runs. The SDK builds this; tools never touch tokens, rate limits
 * or retries themselves — they get an authenticated `http` and the facts they need to compute
 * an honest effect.
 */
export interface ToolContext {
  tenantId: string;
  connectorId: string;
  /** Authenticated client for this connector's provider. Tokens never reach tool code. */
  http: ProviderHttp;
  /** Domains that count as "inside the tenant" when classifying recipients as external. */
  internalDomains: string[];
  /** Connector-level configuration (e.g. the http tool's destination allowlist). */
  config: Record<string, unknown>;
  runId?: string;
  nodeId?: string;
  /** Deterministic key for KEYED tools (run_id + node_id), passed to providers that take one. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

type ToolBody<A extends z.ZodType, E extends z.ZodType> = {
  toolId: string;
  connectorKind: ConnectorKind;
  version: number;
  title: string;
  description: string;
  /** Minimum provider scopes this tool needs. The consent screen is the union of these. */
  scopes: string[];
  egressClass: EgressClass;
  maxTaint: TaintLevel;
  idempotency: Idempotency;
  sensitivityHint: number;
  holdSupported: boolean;
  simulateFidelity: SimulationFidelity;
  /** Taint of what this tool returns. Content read from mail, files or the web: UNTRUSTED. */
  outputTaint: TaintLevel;
  /** Args naming who receives the effect; M3 requires them TRUSTED (module2.md §5.2). */
  recipientArgs: string[];
  argsSchema: A;
  effectSchema: E;
  simulate(args: z.infer<A>, ctx: ToolContext): Promise<Effect<z.infer<E>>>;
  execute(args: z.infer<A>, ctx: ToolContext): Promise<{ effect: Effect<z.infer<E>>; providerRef?: string }>;
  costHint?: { unit: string; estimate: number };
};

/**
 * A complete tool declaration. The intersection with CompensatorRequirement is the TYPE-LEVEL
 * rule: `reversibility: 'R1' | 'R2'` without `compensatorRef` does not compile.
 */
export type ToolDeclaration<A extends z.ZodType = z.ZodType, E extends z.ZodType = z.ZodType> = ToolBody<A, E> &
  CompensatorRequirement;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolDeclaration<any, any>;

export interface HealthReport {
  ok: boolean;
  latencyMs: number;
  detail?: string;
}

/**
 * A connector kind: its tools, the provider it authenticates against, and a health probe.
 * `provider: 'none'` for tools that hold no credential (web fetch, the generic HTTP tool).
 */
export interface ConnectorDefinition {
  kind: ConnectorKind;
  displayName: string;
  provider: 'google' | 'microsoft' | 'slack' | 'none' | 'mcp';
  tools: AnyTool[];
  /** Base URL the tools' relative paths resolve against. Overridable for sandboxes. */
  apiBase: string;
  health(ctx: ToolContext): Promise<HealthReport>;
  /** Provider account identifier (mailbox, workspace) recorded as connectors.account_ref. */
  accountRef?(ctx: ToolContext): Promise<string>;
  /**
   * What this connector will never do, stated for the consent screen (module2.md §6.2).
   * Generated alongside the permissions so the two cannot drift.
   */
  neverDoes: string[];
  /**
   * The inverses of this connector's R1/R2 tools (docs/module6.md §5.4), one per
   * `compensatorRef`. The registry refuses a connector whose R1/R2 tool names a compensator it
   * does not ship — the build-time half of "every R1/R2 action has a tested compensator".
   */
  compensators?: AnyCompensator[];
  /** For tools discovered at runtime (MCP): the compensator a declared R1/R2 tool names. */
  dynamicCompensator?(tool: AnyTool): AnyCompensator | undefined;
}
