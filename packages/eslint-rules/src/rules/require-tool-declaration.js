import { docs, inAny, relativePath } from '../util.js';

/**
 * INVARIANT 4 (PROJECT.md §10.2): "No tool registers without a complete declaration (scopes,
 * egress, reversibility, compensator, max taint, idempotency). Enforced at build time."
 *
 * Module 1 ships the rule; Module 2 turns it on for packages/connectors. It checks every
 * `defineTool({...})` call has every required key written out literally — a declaration built
 * by spreading an object cannot be verified here, so it is refused.
 */
export const REQUIRED_KEYS = ['scopes', 'egress', 'reversibility', 'compensator', 'maxTaint', 'idempotency'];

export default {
  meta: {
    type: 'problem',
    docs: docs('Every tool has a complete, literal declaration', 'PROJECT.md#102-invariants'),
    schema: [
      {
        type: 'object',
        properties: {
          paths: { type: 'array', items: { type: 'string' } },
          factory: { type: 'string' },
          requiredKeys: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing: 'INVARIANT 4 (PROJECT.md §10.2): tool declaration is missing "{{key}}". No tool registers without a complete declaration.',
      notLiteral: 'INVARIANT 4 (PROJECT.md §10.2): {{factory}}() must receive an object literal so the declaration can be verified at build time.',
      spread: 'INVARIANT 4 (PROJECT.md §10.2): spreads are not allowed in a tool declaration — every field must be visible here.',
    },
  },
  create(context) {
    const opts = context.options[0] ?? {};
    if (!inAny(relativePath(context), opts.paths ?? ['packages/connectors/'])) return {};
    const factory = opts.factory ?? 'defineTool';
    const required = opts.requiredKeys ?? REQUIRED_KEYS;
    return {
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== factory) return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== 'ObjectExpression') {
          context.report({ node, messageId: 'notLiteral', data: { factory } });
          return;
        }
        if (arg.properties.some((p) => p.type === 'SpreadElement')) {
          context.report({ node: arg, messageId: 'spread' });
        }
        const keys = new Set(
          arg.properties
            .filter((p) => p.type === 'Property')
            .map((p) => (p.key.type === 'Identifier' ? p.key.name : String(p.key.value))),
        );
        for (const key of required) {
          if (!keys.has(key)) context.report({ node: arg, messageId: 'missing', data: { key } });
        }
      },
    };
  },
};
