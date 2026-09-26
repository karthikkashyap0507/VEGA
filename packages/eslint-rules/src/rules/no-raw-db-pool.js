import { docs, inAny, merge, onModuleSource, relativePath } from '../util.js';

/**
 * Tenant isolation (module1.md §4.1): "A helper in packages/db is the only sanctioned way to
 * open a connection; a lint rule forbids raw pool access outside it." A raw pool is a query
 * path with no tenant context, which is the one thing that breaks RLS.
 */
const DRIVERS = new Set(['pg', 'postgres', 'pg-pool', 'drizzle-orm/node-postgres', 'drizzle-orm/postgres-js']);

export default {
  meta: {
    type: 'problem',
    docs: docs('Database connections only through packages/db (withTenant)', 'module1.md#41-row-level-security'),
    schema: [{ type: 'object', properties: { allow: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      driver:
        'RLS (module1.md §4.1): "{{source}}" opens connections outside packages/db. Use withTenant() from @vega/db — tenant context must be set before any query.',
      pool: 'RLS (module1.md §4.1): constructing a {{name}} outside packages/db bypasses the tenant context helper.',
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? ['packages/db/'];
    if (inAny(relativePath(context), allow)) return {};
    return merge(
      onModuleSource((source, node) => {
        if (DRIVERS.has(source)) context.report({ node, messageId: 'driver', data: { source } });
      }),
      {
        NewExpression(node) {
          const callee = node.callee;
          const name =
            callee.type === 'Identifier'
              ? callee.name
              : callee.type === 'MemberExpression' && callee.property.type === 'Identifier'
                ? callee.property.name
                : undefined;
          if (name === 'Pool') context.report({ node, messageId: 'pool', data: { name } });
        },
      },
    );
  },
};
