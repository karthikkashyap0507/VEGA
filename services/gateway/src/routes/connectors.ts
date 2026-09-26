import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AttachMcpServer,
  Connector,
  ConnectorCatalogEntry,
  ConnectorKind,
  ConnectorWithConsent,
  ConsentView,
  CreateConnector,
  DeclareMcpTool,
  HealthView,
  McpToolView,
  PageQuery,
  ProbeResult,
  SimulateTool,
  ToolView,
  UpdateConnector,
  Uuid,
  pageOf,
} from '@vega/contracts';
import type { GatewayDeps } from '../app.js';
import { defineRoute, toProblem, type RouteHooks } from '../http.js';

/**
 * Connector & tool surface — docs/module2.md §7.
 *
 * NOT HERE, ON PURPOSE: `POST /v1/tools/:toolId/execute`. Direct execution would bypass
 * planning, policy, taint and audit; it exists only on the execution plane's internal
 * listener, reached by the orchestrator. The gateway test asserts the public route is absent.
 */

const IdParam = z.object({ id: Uuid });
const ToolParam = z.object({ toolId: z.string().min(3).max(200) });
const Provider = z.enum(['google', 'microsoft', 'slack']);
const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean));

export function registerConnectorRoutes(app: FastifyInstance, hooks: RouteHooks, deps: GatewayDeps): void {
  const web = (path: string) => new URL(path, deps.config.webUrl).toString();

  // ------------------------------------------------------------------ connectors
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/connectors/catalog',
    summary: 'Connector kinds this deployment offers, with their tool declarations',
    tags: ['connectors'],
    response: z.object({ items: z.array(ConnectorCatalogEntry) }),
    handler: async ({ control }) => ({ items: await control.connectors.catalog.query() }),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/connectors/consent',
    summary: 'The consent transparency model for a kind and a set of tools (generated from declarations)',
    tags: ['connectors'],
    query: z.object({ kind: ConnectorKind, tools: csv.default([]) }),
    response: ConsentView,
    handler: ({ control, query }) => control.connectors.consent.query(query),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/connectors',
    summary: 'Connectors in this tenant, with status',
    tags: ['connectors'],
    query: PageQuery.extend({ kind: ConnectorKind.optional() }),
    response: pageOf(Connector),
    handler: ({ control, query }) => control.connectors.list.query(query),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/connectors',
    summary: 'Create a pending connector and return the provider consent URL',
    tags: ['connectors'],
    body: CreateConnector,
    response: ConnectorWithConsent,
    handler: ({ control, body }) => control.connectors.create.mutate(body),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/connectors/:id',
    summary: 'One connector',
    tags: ['connectors'],
    params: IdParam,
    response: Connector,
    handler: ({ control, params }) => control.connectors.get.query(params),
  });

  defineRoute(app, hooks, {
    method: 'PATCH',
    url: '/v1/connectors/:id',
    summary: 'Display name, workspace scope, enabled tools (may return a re-consent URL)',
    tags: ['connectors'],
    params: IdParam,
    body: UpdateConnector,
    response: ConnectorWithConsent,
    handler: ({ control, params, body }) => control.connectors.update.mutate({ ...body, id: params.id }),
  });

  defineRoute(app, hooks, {
    method: 'DELETE',
    url: '/v1/connectors/:id',
    summary: 'Revoke at the provider, then delete the stored credential',
    tags: ['connectors'],
    params: IdParam,
    response: Connector,
    handler: ({ control, params }) => control.connectors.remove.mutate(params),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/connectors/:id/reauthorize',
    summary: 'A fresh provider consent URL for this connector',
    tags: ['connectors'],
    params: IdParam,
    successStatus: 200,
    response: z.object({ authorizeUrl: z.string().url() }),
    handler: ({ control, params }) => control.connectors.reauthorize.mutate(params),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/connectors/:id/test',
    summary: 'Run the health probe now',
    tags: ['connectors'],
    params: IdParam,
    successStatus: 200,
    response: ProbeResult,
    handler: ({ control, params }) => control.connectors.test.mutate(params),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/connectors/:id/health',
    summary: 'Status, last success and recent connector events',
    tags: ['connectors'],
    params: IdParam,
    response: HealthView,
    handler: ({ control, params }) => control.connectors.health.query(params),
  });

  // ------------------------------------------------------------------ OAuth round-trip
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/oauth/:provider/authorize',
    summary: '302 to the provider consent screen (PKCE + sealed state)',
    tags: ['connectors'],
    params: z.object({ provider: Provider }),
    query: z.object({ connectorId: Uuid }),
    handler: async ({ control, query, reply }) => {
      const { authorizeUrl } = await control.connectors.reauthorize.mutate({ id: query.connectorId });
      return reply.redirect(authorizeUrl, 302);
    },
  });

  /**
   * The provider sends the browser back here. The caller's OWN session authenticates this
   * request, and the control plane checks the sealed state was minted for this same user in
   * this same tenant — a code cannot be injected into someone else's connector.
   */
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/oauth/:provider/callback',
    summary: 'Provider redirect target: verify state, exchange the code, store the credential',
    tags: ['connectors'],
    params: z.object({ provider: Provider }),
    query: z.object({
      code: z.string().max(4096).optional(),
      state: z.string().max(8192).optional(),
      error: z.string().max(200).optional(),
    }),
    handler: async ({ control, params, query, reply, req }) => {
      if (query.error || !query.code || !query.state) {
        return reply.redirect(web(`/admin/connectors?error=${encodeURIComponent(query.error ?? 'missing_code')}`), 302);
      }
      try {
        const { connector } = await control.connectors.completeOAuth.mutate({ provider: params.provider, code: query.code, state: query.state });
        return reply.redirect(web(`/admin/connectors/${connector.id}?authorized=1`), 302);
      } catch (error) {
        const problem = toProblem(error, req.log as never);
        return reply.redirect(web(`/admin/connectors?error=${encodeURIComponent(problem.type.split('/').pop() ?? 'failed')}`), 302);
      }
    },
  });

  // ------------------------------------------------------------------ tools
  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/tools',
    summary: 'Tool declarations, filterable (built-in and this tenant\'s MCP tools)',
    tags: ['tools'],
    query: z.object({ kind: ConnectorKind.optional(), connectorId: Uuid.optional() }),
    response: z.object({ items: z.array(ToolView) }),
    handler: ({ control, query }) => control.tools.list.query(query),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/tools/:toolId',
    summary: 'One tool declaration',
    tags: ['tools'],
    params: ToolParam,
    response: ToolView,
    handler: ({ control, params }) => control.tools.get.query(params),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/tools/:toolId/simulate',
    summary: 'The effect this call WOULD have, computed without side effects',
    tags: ['tools'],
    params: ToolParam,
    body: SimulateTool,
    successStatus: 200,
    handler: ({ control, params, body }) => control.tools.simulate.mutate({ ...body, toolId: params.toolId }),
  });

  // ------------------------------------------------------------------ MCP servers
  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/mcp/servers',
    summary: 'Attach a third-party MCP server; its tools register under conservative defaults',
    tags: ['mcp'],
    body: AttachMcpServer,
    handler: ({ control, body }) => control.mcp.attach.mutate(body),
  });

  defineRoute(app, hooks, {
    method: 'GET',
    url: '/v1/mcp/servers/:id/tools',
    summary: 'Discovered tools; those with declaredBy=default await a declaration',
    tags: ['mcp'],
    params: IdParam,
    response: z.object({ items: z.array(McpToolView) }),
    handler: ({ control, params }) => control.mcp.tools.query(params),
  });

  defineRoute(app, hooks, {
    method: 'POST',
    url: '/v1/mcp/servers/:id/discover',
    summary: 'Re-run tools/list; admin declarations are kept',
    tags: ['mcp'],
    params: IdParam,
    successStatus: 200,
    handler: ({ control, params }) => control.mcp.rediscover.mutate(params),
  });

  defineRoute(app, hooks, {
    method: 'PUT',
    url: '/v1/mcp/servers/:id/tools/:toolId/declaration',
    summary: 'Declare an MCP tool (or adopt the declaration the server published)',
    tags: ['mcp'],
    params: z.object({ id: Uuid, toolId: z.string().min(3).max(200) }),
    body: DeclareMcpTool,
    successStatus: 200,
    handler: ({ control, params, body }) => control.mcp.declare.mutate({ ...params, ...body } as never),
  });
}
