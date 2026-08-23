import { z } from 'zod';
import { AgentStatus } from './enums.js';
import { Timestamp, Uuid } from './common.js';

/**
 * Agents are principals with their OWN identity, distinct from the user they act for
 * (module1.md §5.5). Every action downstream records both `agentId` and
 * `onBehalfOfUserId` — an audit receipt that cannot attribute both is useless (M7),
 * and an autonomy decision that cannot attribute both is unenforceable (M10).
 */
export const Agent = z.object({
  id: Uuid,
  tenantId: Uuid,
  workspaceId: Uuid,
  name: z.string().min(1).max(120),
  version: z.number().int().min(1),
  ownerUserId: Uuid,
  /** Zitadel machine user. Runs mint short-lived scoped tokens against this identity. */
  idpMachineId: z.string().min(1),
  status: AgentStatus,
  createdAt: Timestamp,
});
export type Agent = z.infer<typeof Agent>;

export const CreateAgent = z.object({
  workspaceId: Uuid,
  name: z.string().min(1).max(120),
  ownerUserId: Uuid.optional(),
});
export type CreateAgent = z.infer<typeof CreateAgent>;

export const UpdateAgent = z.object({
  name: z.string().min(1).max(120).optional(),
  ownerUserId: Uuid.optional(),
  status: AgentStatus.optional(),
});
export type UpdateAgent = z.infer<typeof UpdateAgent>;
