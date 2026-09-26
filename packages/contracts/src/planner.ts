import { z } from 'zod';
import { EgressClass, Reversibility, TaintLevel } from './tools.js';

/**
 * The privileged planner's INPUT CONTRACT — docs/module3.md §7.5. Metadata about untrusted
 * content, never the content: the planner plans over shapes, the interpreter extracts content
 * into those shapes. Every string field here is either TRUSTED (the objective, declarations)
 * or constrained to a character class that cannot carry an instruction.
 */

export const SourceMetadata = z
  .object({
    id: z.string().max(300),
    taint: TaintLevel,
    kind: z.enum(['email', 'web', 'file', 'event', 'message', 'record', 'collection', 'unknown']),
    /** Sender / host domain: attacker-influenced, so hostname characters only (§10.1). */
    fromDomain: z.string().regex(/^[a-z0-9.-]{1,253}$/).optional(),
    itemCount: z.number().int().min(0).optional(),
    subjectLength: z.number().int().min(0).optional(),
    bodyLength: z.number().int().min(0).optional(),
    hasAttachments: z.boolean().optional(),
    /** The binding the program refers to it by. */
    binding: z.string().regex(/^[a-z_][a-zA-Z0-9_]*$/).optional(),
  })
  .strict();
export type SourceMetadata = z.infer<typeof SourceMetadata>;

export const PlannerTool = z.object({
  toolId: z.string(),
  title: z.string(),
  description: z.string(),
  egressClass: EgressClass,
  reversibility: Reversibility,
  maxTaint: TaintLevel,
  outputTaint: TaintLevel,
  recipientArgs: z.array(z.string()),
  argsSchema: z.record(z.string(), z.unknown()),
  effectSchema: z.record(z.string(), z.unknown()),
});
export type PlannerTool = z.infer<typeof PlannerTool>;

export const PlannerInput = z.object({
  /** The principal's instruction: TRUSTED by construction (M4's C1 guarantees it). */
  objective: z.string().min(1).max(4000),
  sources: z.array(SourceMetadata).max(200),
  tools: z.array(PlannerTool).max(200),
  schemas: z.array(z.object({ name: z.string(), description: z.string(), jsonSchema: z.record(z.string(), z.unknown()) })).max(100),
  templates: z.array(z.string()).max(50),
  /** Feedback from a rejected previous attempt (static validation errors only). */
  feedback: z.array(z.object({ code: z.string(), message: z.string(), nodeId: z.string().optional() })).max(50).optional(),
});
export type PlannerInput = z.infer<typeof PlannerInput>;
