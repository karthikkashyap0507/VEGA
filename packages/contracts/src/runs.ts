import { z } from 'zod';
import { Timestamp, Uuid } from './common.js';
import { TaintLevel } from './tools.js';

/** Module 4 contracts: the C1 objective, the agent spec, runs. docs/module4.md §4–§7. */

// ------------------------------------------------------------------ C1 objective
export const ResolvedEntity = z.object({
  /** The name the program refers to it by (a TRUSTED input). */
  binding: z.string().regex(/^[a-z_][a-zA-Z0-9_]*$/),
  type: z.enum(['person', 'contact', 'org', 'connector']),
  raw: z.string().max(200),
  resolvedId: z.string().max(300),
  email: z.string().email().optional(),
  name: z.string().max(200).optional(),
  confidence: z.number().min(0).max(1),
  taint: z.literal('TRUSTED'),
});
export type ResolvedEntity = z.infer<typeof ResolvedEntity>;

export const Ambiguity = z.object({
  field: z.string().max(200),
  raw: z.string().max(200),
  /** Best guess used when the ambiguity does not block (R0/R1 only). */
  binding: z.string().regex(/^[a-z_][a-zA-Z0-9_]*$/),
  candidates: z.array(z.object({ id: z.string(), label: z.string(), email: z.string().optional() })).min(2).max(20),
  blocking: z.boolean(),
  resolution: z.string().optional(),
});
export type Ambiguity = z.infer<typeof Ambiguity>;

export const Objective = z.object({
  objective: z.string().min(1).max(4000),
  entities: z.array(ResolvedEntity).max(50),
  constraints: z.array(z.string().max(300)).max(20),
  successCriteria: z.array(z.string().max(300)).max(20),
  ambiguities: z.array(Ambiguity).max(20),
  requestedAutonomy: z.enum(['shadow', 'supervised']).default('supervised'),
  /** Where the objective came from. Only an authenticated principal can originate one. */
  origin: z.object({ kind: z.enum(['principal', 'trigger_rule']), principalUserId: Uuid, trigger: z.string().optional() }),
});
export type Objective = z.infer<typeof Objective>;

// ------------------------------------------------------------------ agent spec
export const Trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('schedule'), cron: z.string().min(9).max(100), tz: z.string().max(64).default('UTC') }),
  z.object({ kind: z.literal('webhook') }),
]);

export const AgentSpec = z.object({
  objectiveTemplate: z.string().max(4000).default(''),
  allowedConnectors: z.array(z.string()).max(20).default([]),
  allowedTools: z.array(z.string()).max(200).default([]),
  triggers: z.array(Trigger).max(10).default([{ kind: 'manual' }]),
  policyBindings: z.array(z.string()).max(50).default([]),
  escalation: z
    .object({ approverRole: z.string().default('APPROVER'), expiry: z.string().regex(/^\d+[mhd]$/).default('4h'), fallback: z.enum(['AUTO_REJECT', 'ESCALATE']).default('AUTO_REJECT') })
    .default({ approverRole: 'APPROVER', expiry: '4h', fallback: 'AUTO_REJECT' }),
  limits: z
    .object({ maxSteps: z.number().int().min(1).max(500).default(50), maxCostCents: z.number().int().min(0).max(100_000).default(200), maxFanout: z.number().int().min(1).max(100).default(20) })
    .default({ maxSteps: 50, maxCostCents: 200, maxFanout: 20 }),
  /** Optional fixed plan in the DSL (scheduled agents, or no planner model configured). */
  program: z.string().max(200_000).optional(),
  /** Read-only until Module 10: displayed, never settable. */
  autonomy: z.literal('SHADOW').default('SHADOW'),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

// ------------------------------------------------------------------ runs
export const RunStatus = z.enum([
  'CREATED',
  'PLANNING',
  'PLANNED',
  'PLAN_REJECTED',
  'EXECUTING',
  'AWAITING_APPROVAL',
  'AWAITING_INPUT',
  'HELD',
  'REPLANNING',
  'COMPENSATING',
  'COMPENSATED',
  'COMPENSATION_FAILED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'NEEDS_ATTENTION',
]);
export type RunStatus = z.infer<typeof RunStatus>;
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(['PLAN_REJECTED', 'COMPENSATED', 'COMPENSATION_FAILED', 'COMPLETED', 'FAILED', 'CANCELLED']);

export const CreateRun = z.object({
  agentId: Uuid,
  objective: z.string().trim().min(1).max(4000).optional(),
  conversationId: Uuid.optional(),
});

export const TaskNodeView = z.object({
  id: Uuid,
  programVersion: z.number().int(),
  stepIndex: z.number().int(),
  callSeq: z.number().int().nullable(),
  dslNodeId: z.string().nullable(),
  kind: z.string(),
  toolId: z.string().nullable(),
  status: z.string(),
  plannedReversibility: z.string().nullable(),
  plannedEgress: z.string().nullable(),
  plannedTaint: TaintLevel.nullable(),
  plannedDecision: z.string().nullable(),
  effect: z.unknown().nullable(),
  error: z.unknown().nullable(),
  startedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
});

export const RunView = z.object({
  id: Uuid,
  tenantId: Uuid,
  workspaceId: Uuid,
  agentId: Uuid,
  agentVersion: z.number().int(),
  principalUserId: Uuid,
  conversationId: Uuid.nullable(),
  trigger: z.string(),
  objective: Objective,
  status: RunStatus,
  statusReason: z.string().nullable(),
  programVersion: z.number().int(),
  replanCount: z.number().int(),
  pending: z.unknown().nullable(),
  result: z.unknown().nullable(),
  error: z.unknown().nullable(),
  costCents: z.number().int(),
  startedAt: Timestamp,
  updatedAt: Timestamp,
  endedAt: Timestamp.nullable(),
});
export type RunView = z.infer<typeof RunView>;

/** A decision on the run's pending approval. It applies to exactly the call the run is waiting on. */
export const RunDecision = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).optional() });
export const RunInput = z.object({ field: z.string().min(1).max(200), choice: z.string().min(1).max(300) });
export const RunListQuery = z.object({
  status: z.array(RunStatus).max(16).optional(),
  agentId: Uuid.optional(),
  workspaceId: Uuid.optional(),
  conversationId: Uuid.optional(),
  limit: z.number().int().min(1).max(200).default(50),
});
