import { z } from 'zod';

/**
 * THE TOOL DECLARATION CONTRACT — docs/module2.md §5.1, PROJECT.md §7.5.
 *
 * FROZEN from Module 2 onward. M3 (taint), M4 (execution), M5 (risk), M6 (reversibility) and
 * M7 (evidence) all import these types. Changes are ADDITIVE ONLY.
 *
 * A tool that cannot fill in every field of this declaration cannot exist in this system:
 * the declaration is what makes undo (D1), proof (D3) and taint gating (D4) possible at all.
 */

// ------------------------------------------------------------------ vocabulary

/** Where an action's effect lands. Drives risk (M5) and the taint gate (M3). */
export const EgressClass = z.enum(['INTERNAL', 'EXTERNAL', 'PUBLIC']);
export type EgressClass = z.infer<typeof EgressClass>;

/**
 * Reversibility class (PROJECT.md §8.1):
 *   R0  no side effect (reads)
 *   R1  reversible by a compensator, no external observer
 *   R2  reversible within a hold window; observable once released
 *   R3  irreversible — at-most-once, placed last in a plan wherever possible
 */
export const Reversibility = z.enum(['R0', 'R1', 'R2', 'R3']);
export type Reversibility = z.infer<typeof Reversibility>;

/**
 * Taint levels, least to most tainted. Module 3 owns propagation; Module 2 assigns labels at
 * the source and declares the highest level each tool accepts in its arguments.
 */
export const TaintLevel = z.enum(['TRUSTED', 'ORG', 'UNTRUSTED']);
export type TaintLevel = z.infer<typeof TaintLevel>;
export const TAINT_ORDER: Readonly<Record<TaintLevel, number>> = { TRUSTED: 0, ORG: 1, UNTRUSTED: 2 };

export const Idempotency = z.enum(['NATIVE', 'KEYED', 'NONE']);
export type Idempotency = z.infer<typeof Idempotency>;

export const ConnectorKind = z.enum([
  'gmail',
  'gcal',
  'gdrive',
  'outlook',
  'sharepoint',
  'slack',
  'web',
  'http',
  'mcp',
]);
export type ConnectorKind = z.infer<typeof ConnectorKind>;

export const ConnectorStatus = z.enum(['pending', 'active', 'degraded', 'expired', 'revoked']);
export type ConnectorStatus = z.infer<typeof ConnectorStatus>;

/** How `simulate()` knows what it claims. DECLARED tools cannot pass SUPERVISED autonomy (M10). */
export const SimulationFidelity = z.enum(['PROVIDER', 'DERIVED', 'DECLARED']);
export type SimulationFidelity = z.infer<typeof SimulationFidelity>;

/** Normalized connector errors (module2.md §5.3). Providers' own codes never leak past the SDK. */
export const ToolErrorCode = z.enum([
  'AUTH_EXPIRED',
  'RATE_LIMITED',
  'NOT_FOUND',
  'PERMISSION_DENIED',
  'CONFLICT',
  'PROVIDER_ERROR',
  'TRANSIENT',
  'VALIDATION',
  'EGRESS_DENIED',
  'CONNECTOR_UNAVAILABLE',
  /**
   * A previous invocation with this idempotency key was claimed and never finished (the process
   * died mid-call): it may or may not have happened. Never retried; the executor escalates it.
   */
  'OUTCOME_UNKNOWN',
]);
export type ToolErrorCode = z.infer<typeof ToolErrorCode>;

// ------------------------------------------------------------------ provenance

/**
 * Provenance envelope (module2.md §16). Every value a connector READS comes back wrapped: M3
 * propagates labels, it never has to invent them. `sourceId` is content-addressable from M7.
 */
export interface Sourced<T> {
  value: T;
  sourceId: string;
  taint: TaintLevel;
}

export const SourcedSchema = <T extends z.ZodType>(value: T) =>
  z.object({ value, sourceId: z.string().min(1), taint: TaintLevel });

// ------------------------------------------------------------------ effects

export const RecordAffected = z.object({
  system: z.string(),
  id: z.string(),
  field: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type RecordAffected = z.infer<typeof RecordAffected>;

/** What an action does (or would do). `simulate()` and `execute()` return the SAME shape. */
export interface Effect<T> {
  /** One human sentence for the blast-radius panel. */
  summary: string;
  fidelity: SimulationFidelity;
  /** Addresses outside the tenant. Drives risk and the duplicate-contact ledger (M10). */
  externalRecipients: string[];
  recordsAffected: RecordAffected[];
  monetaryValue?: { currency: string; amount: number };
  /** e.g. "attendees will see a cancellation" — what undo cannot hide. */
  reversibilityNote?: string;
  detail: T;
}

export const EffectSchema = <T extends z.ZodType>(detail: T) =>
  z.object({
    summary: z.string(),
    fidelity: SimulationFidelity,
    externalRecipients: z.array(z.string()),
    recordsAffected: z.array(RecordAffected),
    monetaryValue: z.object({ currency: z.string(), amount: z.number() }).optional(),
    reversibilityNote: z.string().optional(),
    detail,
  });

export type ToolResult<T> =
  | { ok: true; effect: Effect<T>; providerRef?: string }
  | { ok: false; error: { code: ToolErrorCode; message: string; retryAfterSeconds?: number } };

// ------------------------------------------------------------------ the declaration

/**
 * The serializable half of a declaration: everything except the functions. This is what the
 * control plane, the risk engine and the audit receipt see, and what `tool_declarations` stores.
 */
export const ToolDeclarationRecord = z.object({
  toolId: z.string().regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/, 'connector.tool'),
  connectorKind: ConnectorKind,
  version: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  scopes: z.array(z.string()),
  egressClass: EgressClass,
  reversibility: Reversibility,
  maxTaint: TaintLevel,
  idempotency: Idempotency,
  sensitivityHint: z.number().int().min(0).max(100),
  holdSupported: z.boolean(),
  simulateFidelity: SimulationFidelity,
  compensatorRef: z.string().nullable(),
  /** Taint of what this tool RETURNS (reads). Always UNTRUSTED for message/web content. */
  outputTaint: TaintLevel,
  /** Arguments that name WHO receives an effect. M3 requires these be TRUSTED (§5.2). */
  recipientArgs: z.array(z.string()),
  argsSchema: z.record(z.string(), z.unknown()),
  effectSchema: z.record(z.string(), z.unknown()),
  costHint: z.object({ unit: z.string(), estimate: z.number() }).nullable(),
});
export type ToolDeclarationRecord = z.infer<typeof ToolDeclarationRecord>;

/**
 * Reversibility rules as TYPES (module2.md §5.1): an R1 or R2 tool without a compensator does
 * not typecheck. The database CHECK constraint is the second line of defence, not the first.
 */
export type CompensatorRequirement =
  | { reversibility: 'R0' | 'R3'; compensatorRef?: undefined }
  | { reversibility: 'R1' | 'R2'; compensatorRef: string };
