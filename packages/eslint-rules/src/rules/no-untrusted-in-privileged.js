import { docs, inAny, merge, onModuleSource, relativePath } from '../util.js';

/**
 * INVARIANT 5 (PROJECT.md §10.2): "The privileged planner never receives raw untrusted
 * content. Enforced by type, not by prompt."
 *
 * Module 1 ships the rule; Module 3 turns it on by naming the privileged paths (the planner)
 * and the untrusted type names (the taint lattice's UNTRUSTED carriers). Once configured, a
 * privileged file may not import a module that exports untrusted values, nor reference an
 * untrusted type by name.
 */
export default {
  meta: {
    type: 'problem',
    docs: docs('The privileged planner never sees untrusted content', 'PROJECT.md#102-invariants'),
    schema: [
      {
        type: 'object',
        properties: {
          privilegedPaths: { type: 'array', items: { type: 'string' } },
          untrustedModules: { type: 'array', items: { type: 'string' } },
          untrustedTypes: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      module: 'INVARIANT 5 (PROJECT.md §10.2): privileged code must not import "{{source}}", which carries untrusted content.',
      type: 'INVARIANT 5 (PROJECT.md §10.2): privileged code must not reference the untrusted type "{{name}}". Pass a quarantined, typed extraction instead.',
    },
  },
  create(context) {
    const opts = context.options[0] ?? {};
    const privileged = opts.privilegedPaths ?? [];
    if (privileged.length === 0 || !inAny(relativePath(context), privileged)) return {};
    const modules = opts.untrustedModules ?? [];
    const types = new Set(opts.untrustedTypes ?? []);
    return merge(
      onModuleSource((source, node) => {
        if (modules.some((m) => source === m || source.startsWith(m + '/'))) {
          context.report({ node, messageId: 'module', data: { source } });
        }
      }),
      {
        TSTypeReference(node) {
          const name = node.typeName.type === 'Identifier' ? node.typeName.name : undefined;
          if (name && types.has(name)) context.report({ node, messageId: 'type', data: { name } });
        },
        ImportSpecifier(node) {
          const name = node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
          if (types.has(name)) context.report({ node, messageId: 'type', data: { name } });
        },
      },
    );
  },
};
