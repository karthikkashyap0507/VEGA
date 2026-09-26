import { docs, inAny, merge, onModuleSource, relativePath } from '../util.js';

/**
 * INVARIANT 1 (PROJECT.md §10.2): the execution plane may append to the evidence plane,
 * never read, modify or delete it. In code, that means the execution plane never imports the
 * evidence database module or the evidence service — only its own HTTP append client.
 */
const FORBIDDEN_SOURCES = [/^@vega\/db\/evidence(\/|$)/, /^@vega\/service-evidence(\/|$)/, /evidence\/(write|client|writer)/];
const FORBIDDEN_NAMES = new Set(['EvidenceWriter', 'migrateEvidence']);

export default {
  meta: {
    type: 'problem',
    docs: docs('Execution plane reaches the evidence plane only through HTTP /append', 'PROJECT.md#102-invariants'),
    schema: [{ type: 'object', properties: { executionPaths: { type: 'array', items: { type: 'string' } } }, additionalProperties: false }],
    messages: {
      source:
        'INVARIANT 1 (PROJECT.md §10.2): the execution plane must not import "{{source}}". Use the HTTP EvidenceAppendClient — the execution plane holds no evidence-DB access.',
      name: 'INVARIANT 1 (PROJECT.md §10.2): "{{name}}" is an evidence-plane write primitive and cannot be used from the execution plane.',
    },
  },
  create(context) {
    const paths = context.options[0]?.executionPaths ?? ['services/execution/'];
    if (!inAny(relativePath(context), paths)) return {};
    return merge(
      onModuleSource((source, node) => {
        if (FORBIDDEN_SOURCES.some((re) => re.test(source))) {
          context.report({ node, messageId: 'source', data: { source } });
        }
      }),
      {
        ImportSpecifier(node) {
          const name = node.imported.type === 'Identifier' ? node.imported.name : node.imported.value;
          if (FORBIDDEN_NAMES.has(name)) context.report({ node, messageId: 'name', data: { name } });
        },
      },
    );
  },
};
