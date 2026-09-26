import { z } from 'zod';
import { WorkspaceRole } from './enums.js';
import { Slug, Timestamp, Uuid } from './common.js';

export const Workspace = z.object({
  id: Uuid,
  tenantId: Uuid,
  name: z.string().min(1).max(200),
  slug: Slug,
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Workspace = z.infer<typeof Workspace>;

export const CreateWorkspace = z.object({
  name: z.string().min(1).max(200),
  slug: Slug.optional(),
});
export type CreateWorkspace = z.infer<typeof CreateWorkspace>;

export const WorkspaceMember = z.object({
  workspaceId: Uuid,
  userId: Uuid,
  role: WorkspaceRole,
  addedAt: Timestamp,
});
export type WorkspaceMember = z.infer<typeof WorkspaceMember>;

export const UpdateWorkspace = z.object({
  name: z.string().min(1).max(200).optional(),
  /** true archives, false restores. Archival is reversible; deletion is not offered. */
  archived: z.boolean().optional(),
});
export type UpdateWorkspace = z.infer<typeof UpdateWorkspace>;

export const AddWorkspaceMember = z.object({
  userId: Uuid,
  role: WorkspaceRole.default('member'),
});
export type AddWorkspaceMember = z.infer<typeof AddWorkspaceMember>;
