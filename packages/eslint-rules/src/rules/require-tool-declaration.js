import { docs, inAny, relativePath } from '../util.js';

/**
 * INVARIANT 4 (PROJECT.md §10.2): "No tool registers without a complete declaration (scopes,
 * egress, reversibility, compensator, max taint, idempotency). Enforced at build time."
 *
 * It checks every `defineTool({...})` call in packages/connectors has every required key written
 * out literally — a declaration built by spreading an object cannot be verified here, so it is
 * refused. The compensator is conditional (docs/module2.md §5.1): R1/R2 tools must name one,
 * R0/R3 tools must not. The type system enforces the same rule (CompensatorRequirement); this
 * rule is the line that holds when someone reaches for `as any`.
 */
export const REQUIRED_KEYS = [
  'toolId',
  'scopes',
  'egressClass',
  'reversibility',
  'maxTaint',
  'outputTaint',
  'idempotency',
  'recipientArgs',
  'argsSchema',
  'effectSchema',
  'simulate',
  'execute',
];

const NEEDS_COMPENSATOR = new Set(['R1', 'R2']);

function keyName(p) {
  return p.key.type === 'Identifier' ? p.key.name : String(p.key.value);
}

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
          runtimeFactory: { type: 'string' },
          runtimeAllowedPaths: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missing: 'INVARIANT 4 (PROJECT.md §10.2): tool declaration is missing "{{key}}". No tool registers without a complete declaration.',
      notLiteral: 'INVARIANT 4 (PROJECT.md §10.2): {{factory}}() must receive an object literal so the declaration can be verified at build time.',
      spread: 'INVARIANT 4 (PROJECT.md §10.2): spreads are not allowed in a tool declaration — every field must be visible here.',
      reversibilityNotLiteral: 'INVARIANT 4 (PROJECT.md §10.2): "reversibility" must be a string literal (R0–R3) so the compensator rule can be checked.',
      compensatorRequired: 'INVARIANT 4 (PROJECT.md §10.2): a {{rev}} tool must declare "compensatorRef" — an irreversible effect needs its undo named up front.',
      runtimeFactory: 'INVARIANT 4 (PROJECT.md §10.2): {{factory}}() skips the build-time check and is reserved for declarations that are data (MCP, in {{paths}}). Use defineTool({...}) here.',
      compensatorForbidden: 'INVARIANT 4 (PROJECT.md §10.2): a {{rev}} tool must not declare "compensatorRef" — {{why}}.',
    },
  },
  create(context) {
    const opts = context.options[0] ?? {};
    if (!inAny(relativePath(context), opts.paths ?? ['packages/connectors/'])) return {};
    const factory = opts.factory ?? 'defineTool';
    const required = opts.requiredKeys ?? REQUIRED_KEYS;
    const runtimeFactory = opts.runtimeFactory ?? 'defineRuntimeTool';
    const runtimePaths = opts.runtimeAllowedPaths ?? ['packages/connectors/mcp/'];
    const runtimeAllowed = inAny(relativePath(context), runtimePaths);
    return {
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === runtimeFactory && !runtimeAllowed) {
          context.report({ node, messageId: 'runtimeFactory', data: { factory: runtimeFactory, paths: runtimePaths.join(', ') } });
          return;
        }
        if (node.callee.type !== 'Identifier' || node.callee.name !== factory) return;
        const arg = node.arguments[0];
        if (!arg || arg.type !== 'ObjectExpression') {
          context.report({ node, messageId: 'notLiteral', data: { factory } });
          return;
        }
        if (arg.properties.some((p) => p.type === 'SpreadElement')) {
          context.report({ node: arg, messageId: 'spread' });
        }
        const props = new Map(
          arg.properties.filter((p) => p.type === 'Property').map((p) => [keyName(p), p]),
        );
        for (const key of required) {
          if (!props.has(key)) context.report({ node: arg, messageId: 'missing', data: { key } });
        }
        const rev = props.get('reversibility');
        if (!rev) return;
        const v = rev.value;
        if (v.type !== 'Literal' || typeof v.value !== 'string') {
          context.report({ node: rev, messageId: 'reversibilityNotLiteral' });
          return;
        }
        const comp = props.get('compensatorRef');
        const hasComp = comp && !(comp.value.type === 'Literal' && comp.value.value === null);
        if (NEEDS_COMPENSATOR.has(v.value) && !hasComp) {
          context.report({ node: arg, messageId: 'compensatorRequired', data: { rev: v.value } });
        } else if (!NEEDS_COMPENSATOR.has(v.value) && hasComp) {
          const why = v.value === 'R0' ? 'it changes nothing, so there is nothing to undo' : 'R3 means no undo exists; naming one would lie to the approver';
          context.report({ node: comp, messageId: 'compensatorForbidden', data: { rev: v.value, why } });
        }
      },
    };
  },
};
