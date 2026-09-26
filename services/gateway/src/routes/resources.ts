import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AddWorkspaceMember,
  Agent,
  AgentStatus,
  CreateAgent,
  CreateWorkspace,
  InviteUser,
  Me,
  PageQuery,
  RETENTION_DAYS_FLOOR,
  Tenant,
  UpdateAgent,
  UpdateTenant,
  UpdateUser,
  UpdateWorkspace,
  User,
  Uuid,
  Workspace,
  pageOf,
} from '@vega/contracts';
import type { GatewayDeps } from '../app.js';
import { defineRoute, type RouteHooks } from '../http.js';

/**
 * The /v1 resource surface — module1.md §7.1. A thin mapping from REST to control-plane
 * procedures: the gateway adds authentication, rate limits and idempotency, and makes no
 * authorization decisions of its own. Every rule lives next to the data it protects.
 */

const IdParam = z.object({ id: Uuid });
const bool = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

export function registerResourceRoutes(app: FastifyInstance, hooks: RouteHooks, _deps: GatewayDeps): void {
  // ------------------------------------------------------------------ me
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/me',
    summary: 'Identity, roles and tenant of the caller',
    tags: ['identity'],
    response: Me,
    handler: ({ control }) => control.me.get.query(),
  });

  // ------------------------------------------------------------------ tenant
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/tenants/current',
    summary: 'The caller\'s tenant',
    tags: ['tenant'],
    response: Tenant,
    handler: ({ control }) => control.tenants.current.query(),
  });

  defineRoute(app, hooks, {
    method: 'PATCH',
    url: '/v1/tenants/current',
    summary: `Update name, retention (>= ${RETENTION_DAYS_FLOOR} days) or settings (ADMIN)`,
    tags: ['tenant'],
    body: UpdateTenant.extend({ settings: z.record(z.string(), z.unknown()).optional() }),
    response: Tenant,
    handler: ({ control, body }) => control.tenants.update.mutate(body as never),
  });

  // ------------------------------------------------------------------ users
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/users',
    summary: 'Users in this tenant',
    tags: ['users'],
    query: PageQuery.extend({ status: z.enum(['active', 'invited', 'deactivated']).optional() }),
    response: pageOf(User),
    handler: ({ control, query }) => control.users.list.query(query),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/users/invite',
    summary: 'Invite a user (creates the identity in the tenant\'s organization)',
    tags: ['users'],
    body: InviteUser,
    response: z.object({ user: User, inviteCode: z.string().optional() }),
    handler: ({ control, body }) => control.users.invite.mutate(body),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/users/:id',
    summary: 'One user',
    tags: ['users'],
    params: IdParam,
    response: User,
    handler: ({ control, params }) => control.users.get.query(params),
  });

  defineRoute(app, hooks, {
    method: 'PATCH',
    url: '/v1/users/:id',
    summary: 'Change role or status',
    tags: ['users'],
    params: IdParam,
    body: UpdateUser,
    response: User,
    handler: ({ control, params, body }) => control.users.update.mutate({ ...body, id: params.id }),
  });

  defineRoute(app, hooks, {
    method: 'DELETE',
    url: '/v1/users/:id',
    summary: 'Remove a user (deactivates; users are never hard-deleted)',
    tags: ['users'],
    params: IdParam,
    handler: ({ control, params }) => control.users.remove.mutate(params),
  });

  // ------------------------------------------------------------------ workspaces
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/workspaces',
    summary: 'Workspaces visible to the caller',
    tags: ['workspaces'],
    query: PageQuery.extend({ includeArchived: bool.optional() }),
    response: pageOf(Workspace),
    handler: ({ control, query }) =>
      control.workspaces.list.query({ ...query, includeArchived: query.includeArchived ?? false }),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/workspaces',
    summary: 'Create a workspace; the caller becomes its owner',
    tags: ['workspaces'],
    body: CreateWorkspace,
    response: Workspace,
    handler: ({ control, body }) => control.workspaces.create.mutate(body),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/workspaces/:id',
    summary: 'One workspace',
    tags: ['workspaces'],
    params: IdParam,
    response: Workspace,
    handler: ({ control, params }) => control.workspaces.get.query(params),
  });

  defineRoute(app, hooks, {
    method: 'PATCH',
    url: '/v1/workspaces/:id',
    summary: 'Rename or archive',
    tags: ['workspaces'],
    params: IdParam,
    body: UpdateWorkspace,
    response: Workspace,
    handler: ({ control, params, body }) => control.workspaces.update.mutate({ ...body, id: params.id }),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/workspaces/:id/members',
    summary: 'Members of a workspace',
    tags: ['workspaces'],
    params: IdParam,
    handler: async ({ control, params }) => ({ items: await control.workspaces.members.query(params) }),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/workspaces/:id/members',
    summary: 'Add or re-role a member',
    tags: ['workspaces'],
    params: IdParam,
    body: AddWorkspaceMember,
    handler: ({ control, params, body }) => control.workspaces.addMember.mutate({ ...body, id: params.id }),
  });

  defineRoute(app, hooks, {
    method: 'DELETE',
    url: '/v1/workspaces/:id/members/:userId',
    summary: 'Remove a member',
    tags: ['workspaces'],
    params: z.object({ id: Uuid, userId: Uuid }),
    handler: ({ control, params }) => control.workspaces.removeMember.mutate(params),
  });

  // ------------------------------------------------------------------ agents
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/agents',
    summary: 'Agents visible to the caller',
    tags: ['agents'],
    query: PageQuery.extend({ workspaceId: Uuid.optional(), status: AgentStatus.optional() }),
    response: pageOf(Agent),
    handler: ({ control, query }) => control.agents.list.query(query),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/agents',
    summary: 'Create an agent (provisions a distinct machine identity)',
    tags: ['agents'],
    body: CreateAgent,
    response: Agent,
    handler: ({ control, body }) => control.agents.create.mutate(body),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/agents/:id',
    summary: 'One agent',
    tags: ['agents'],
    params: IdParam,
    response: Agent,
    handler: ({ control, params }) => control.agents.get.query(params),
  });

  defineRoute(app, hooks, {
    method: 'PATCH',
    url: '/v1/agents/:id',
    summary: 'Rename, re-own, suspend or (with a spec) activate',
    tags: ['agents'],
    params: IdParam,
    body: UpdateAgent,
    response: Agent,
    handler: ({ control, params, body }) => control.agents.update.mutate({ ...body, id: params.id }),
  });

  defineRoute(app, hooks, {
    method: 'DELETE',
    url: '/v1/agents/:id',
    summary: 'Archive an agent (identity deactivated, row retained for audit)',
    tags: ['agents'],
    params: IdParam,
    response: Agent,
    handler: ({ control, params }) => control.agents.remove.mutate(params),
  });
}
