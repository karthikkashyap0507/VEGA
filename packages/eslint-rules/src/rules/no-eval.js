import { docs, inAny, merge, onModuleSource, relativePath } from '../util.js';

/**
 * Sandboxing (module1.md §5.6, TECHSTACK §9): no eval, new Function, or node:vm outside the
 * one package allowed to host a sandbox. The capability interpreter is a restricted DSL
 * precisely so that dynamic code execution never needs to exist — invariant 5 depends on it.
 */
const VM = new Set(['vm', 'node:vm']);

export default {
  meta: {
    type: 'problem',
    docs: docs('No dynamic code execution outside the sandbox package', 'PROJECT.md#102-invariants'),
    schema: [{ type: 'object', properties: { allow: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      eval: 'SANDBOXING (PROJECT.md §10.2 invariant 5, TECHSTACK §9): {{what}} executes dynamic code. Only the sandbox package may do this.',
    },
  },
  create(context) {
    const allow = context.options[0]?.allow ?? ['packages/taint/'];
    if (inAny(relativePath(context), allow)) return {};
    const report = (node, what) => context.report({ node, messageId: 'eval', data: { what } });
    return merge(
      onModuleSource((source, node) => {
        if (VM.has(source)) report(node, `importing "${source}"`);
      }),
      {
        CallExpression(node) {
          const c = node.callee;
          if (c.type === 'Identifier' && c.name === 'eval') report(node, 'eval()');
          if (c.type === 'MemberExpression' && c.property.type === 'Identifier' && c.property.name === 'eval' &&
              c.object.type === 'Identifier' && ['globalThis', 'window', 'global', 'self'].includes(c.object.name)) {
            report(node, `${c.object.name}.eval()`);
          }
          // setTimeout("code") / setInterval("code") are eval in disguise.
          if (c.type === 'Identifier' && (c.name === 'setTimeout' || c.name === 'setInterval') &&
              node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
            report(node, `${c.name} with a string argument`);
          }
          if (c.type === 'Identifier' && c.name === 'Function') report(node, 'Function()');
        },
        NewExpression(node) {
          if (node.callee.type === 'Identifier' && node.callee.name === 'Function') report(node, 'new Function()');
        },
      },
    );
  },
};
