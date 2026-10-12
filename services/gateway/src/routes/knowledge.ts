import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Uuid } from '@vega/contracts';
import { defineRoute, type RouteHooks } from '../http.js';

/**
 * Verification, Memory & Knowledge — docs/module9.md §9. Memory belongs to its subject (the
 * control plane enforces who may see and change what); knowledge search is ACL-gated as the
 * caller — an inspection surface, never a way around document permissions.
 */
export function registerKnowledgeRoutes(app: FastifyInstance, hooks: RouteHooks): void {
  const Id = z.object({ id: Uuid });
  const RunId = z.object({ id: Uuid });
  const MemoryClass = z.enum(['preference', 'working_context', 'task_history', 'org_knowledge', 'long_term_style']);
  const Scope = z.enum(['user', 'workspace', 'tenant']);

  // ------------------------------------------------------------ verification
  let tags = ['verification'];
  defineRoute(app, hooks, { method: 'GET', url: '/v1/runs/:id/verifications', summary: 'Every verification of a run, with its six checks', tags, params: RunId, handler: ({ control, params }) => control.verifications.forRun.query({ runId: params.id }) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/verifications/:id', summary: 'One verification: per-check detail', tags, params: Id, handler: ({ control, params }) => control.verifications.get.query(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/verifications/:id/groundedness', summary: 'Claim-level findings: supported, unsupported or contradicted, and by what', tags, params: Id, handler: ({ control, params }) => control.verifications.groundedness.query(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/runs/:id/retrievals', summary: 'The retrieval inspector: what was retrieved, from where, and how much was withheld by permission', tags, params: RunId, handler: ({ control, params }) => control.retrievals.forRun.query({ runId: params.id }) });

  // ------------------------------------------------------------ memory
  tags = ['memory'];
  defineRoute(app, hooks, { method: 'GET', url: '/v1/memories', summary: 'Memories you can see: yours, your workspaces’, the organization’s', tags, query: z.object({ scope: Scope.optional(), class: MemoryClass.optional(), includeInactive: z.coerce.boolean().optional() }), handler: ({ control, query }) => control.memories.list.query(query) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/memories',
    summary: 'Tell the system something to remember (TRUSTED by definition)',
    tags,
    body: z.object({ scope: Scope.default('user'), workspaceId: Uuid.optional(), class: MemoryClass, content: z.string().trim().min(1).max(2000) }),
    handler: ({ control, body }) => control.memories.create.mutate(body),
  });
  defineRoute(app, hooks, {
    method: 'PATCH',
    url: '/v1/memories/:id',
    summary: 'Edit (it becomes yours and is never overwritten), pin, or mark stale',
    tags,
    params: Id,
    body: z.object({ content: z.string().trim().min(1).max(2000).optional(), pinned: z.boolean().optional(), stale: z.boolean().optional() }),
    handler: ({ control, params, body }) => control.memories.update.mutate({ id: params.id, ...body }),
  });
  defineRoute(app, hooks, { method: 'DELETE', url: '/v1/memories/:id', summary: 'Delete — immediate and permanent', tags, params: Id, handler: ({ control, params }) => control.memories.delete.mutate(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/memories/conflicts', summary: 'Contradictions waiting for you to decide (never resolved automatically)', tags, handler: ({ control }) => control.memories.conflicts.query() });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/memories/conflicts/:id/resolve',
    summary: 'Keep the old, take the new, merge in your words, or keep both',
    tags,
    params: Id,
    body: z.object({ resolution: z.enum(['keep_existing', 'accept_new', 'merge', 'both_valid']), mergedContent: z.string().trim().max(2000).optional() }),
    successStatus: 200,
    handler: ({ control, params, body }) => control.memories.resolve.mutate({ id: params.id, ...body }),
  });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/memories/export', summary: 'Everything remembered about you, with provenance', tags, handler: ({ control }) => control.memories.export.query() });

  // ------------------------------------------------------------ knowledge base
  tags = ['knowledge'];
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/kb/documents',
    summary: 'Upload a document (base64): parsed, chunked by structure, classified, embedded self-hosted, ACL mirrored',
    tags,
    bodyLimit: 28 * 1024 * 1024,
    body: z.object({
      title: z.string().trim().min(1).max(500),
      mime: z.string().min(3).max(200),
      dataBase64: z.string().min(1),
      workspaceId: Uuid.optional(),
      aclUsers: z.array(Uuid).max(500).optional(),
      sourceKind: z.enum(['upload', 'email_attachment', 'url']).optional(),
      externalRef: z.string().max(2000).optional(),
    }),
    handler: ({ control, body }) => control.kb.upload.mutate(body),
  });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/kb/documents', summary: 'Documents: sensitivity, index state, chunks', tags, handler: ({ control }) => control.kb.documents.query() });
  defineRoute(app, hooks, { method: 'DELETE', url: '/v1/kb/documents/:id', summary: 'Delete: chunks, stored bytes and ACL tuples go with it', tags, params: Id, handler: ({ control, params }) => control.kb.delete.mutate(params) });
  defineRoute(app, hooks, { method: 'POST', url: '/v1/kb/documents/:id/reindex', summary: 'Parse, chunk and embed again', tags, params: Id, successStatus: 200, handler: ({ control, params }) => control.kb.reindex.mutate(params) });
  defineRoute(app, hooks, { method: 'GET', url: '/v1/kb/documents/:id/acl-preview', summary: 'Who can retrieve this document', tags, params: Id, handler: ({ control, params }) => control.kb.aclPreview.query(params) });
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/kb/search',
    summary: 'Search as yourself (ACL-gated; reports how many results were withheld)',
    tags,
    body: z.object({ query: z.string().trim().min(1).max(2000), k: z.number().int().min(1).max(20).optional() }),
    successStatus: 200,
    handler: ({ control, body }) => control.kb.search.mutate({ query: body.query, k: body.k ?? 5 }),
  });
}
