import { docs, inAny, merge, onModuleSource, relativePath } from '../util.js';

/**
 * module1.md §5.6: "Every control/execution service handler resolves tenant before data
 * access." Enforced structurally, because "did this handler set the tenant" is not decidable
 * from one function's AST:
 *
 *   1. Service code cannot reach an unscoped connection: withSystemBypassingRls, getAppPool,
 *      getSystemPool and the raw resolver helpers are off-limits outside an explicit allowlist
 *      (provisioning-free: tenant creation uses withTenant(newId)).
 *   2. Control-plane routers build procedures only from the authed `procedure` (tenant
 *      resolved in middleware) or a named system procedure — never the bare `t.procedure`
 *      or a `publicProcedure`.
 *   3. tenant ids are never read from request headers/query/body (`req.headers['x-tenant-id']`
 *      and friends) — CONTRIBUTING.md: "Tenant context comes only from verified token claims."
 */
const UNSCOPED = new Set(['withSystemBypassingRls', 'getSystemPool', 'getAppPool']);
const TENANT_KEY = /^(x-)?(vega-)?tenant(-|_)?id$|^tenantId$/i;

export default {
  meta: {
    type: 'problem',
    docs: docs('Tenant context is resolved from verified claims before data access', 'module1.md#81-sign-in-and-tenant-resolution'),
    schema: [
      {
        type: 'object',
        properties: {
          servicePaths: { type: 'array', items: { type: 'string' } },
          routerPaths: { type: 'array', items: { type: 'string' } },
          allowUnscoped: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unscoped:
        'TENANT CONTEXT (module1.md §4.1, §5.6): "{{name}}" gives this handler a connection with no tenant context. Use ctx.db()/withTenant() with a tenant from a verified principal.',
      bareProcedure:
        'TENANT CONTEXT (module1.md §5.6): routers must use the authed `procedure` (tenant resolved by middleware) or a named system procedure, not "{{name}}".',
      requestTenant:
        'TENANT CONTEXT (CONTRIBUTING.md, module1.md §8.1): tenant ids never come from a request {{where}}. Use the verified principal.',
    },
  },
  create(context) {
    const rel = relativePath(context);
    const opts = context.options[0] ?? {};
    const services = opts.servicePaths ?? ['services/control/src/', 'services/execution/src/', 'services/gateway/src/'];
    if (!inAny(rel, services)) return {};
    const allowUnscoped = inAny(rel, opts.allowUnscoped ?? []);
    const inRouter = inAny(rel, opts.routerPaths ?? ['services/control/src/routers/']);

    return merge(
      onModuleSource(() => undefined),
      {
        ImportSpecifier(node) {
          const name = node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
          if (!allowUnscoped && UNSCOPED.has(name)) context.report({ node, messageId: 'unscoped', data: { name } });
        },
        MemberExpression(node) {
          // t.procedure / publicProcedure inside routers
          if (inRouter && node.property.type === 'Identifier' && node.property.name === 'procedure' &&
              node.object.type === 'Identifier' && node.object.name === 't') {
            context.report({ node, messageId: 'bareProcedure', data: { name: 't.procedure' } });
          }
          // req.headers['x-tenant-id'], req.query.tenantId, req.body.tenantId
          const obj = node.object;
          if (obj.type === 'MemberExpression' && obj.property.type === 'Identifier' &&
              ['headers', 'query', 'body', 'params'].includes(obj.property.name)) {
            const key = node.computed
              ? node.property.type === 'Literal' ? String(node.property.value) : undefined
              : node.property.type === 'Identifier' ? node.property.name : undefined;
            if (key && TENANT_KEY.test(key)) {
              context.report({ node, messageId: 'requestTenant', data: { where: obj.property.name } });
            }
          }
        },
        Identifier(node) {
          if (inRouter && node.name === 'publicProcedure') {
            context.report({ node, messageId: 'bareProcedure', data: { name: 'publicProcedure' } });
          }
        },
      },
    );
  },
};
