import { docs, inAny, relativePath } from '../util.js';

/**
 * docs/module3.md §7.1: "There is no constructor that produces a TaintedValue without a taint —
 * a lint rule forbids `as unknown as TaintedValue` casts." A cast is how a label gets forged in
 * code review's blind spot; outside packages/taint, any `as TaintedValue` / `<TaintedValue>`
 * assertion is an error. (The runtime registry catches forgeries too; this catches them early.)
 */
export default {
  meta: {
    type: 'problem',
    docs: docs('Taint labels cannot be forged with a type assertion', 'docs/module3.md#71-value-representation'),
    schema: [
      {
        type: 'object',
        properties: { types: { type: 'array', items: { type: 'string' } }, allow: { type: 'array', items: { type: 'string' } } },
        additionalProperties: false,
      },
    ],
    messages: {
      cast: 'docs/module3.md §7.1: do not assert "{{name}}". Mint values with literal()/fromSource()/derive() from @vega/taint.',
    },
  },
  create(context) {
    const opts = context.options[0] ?? {};
    if (inAny(relativePath(context), opts.allow ?? ['packages/taint/'])) return {};
    const types = new Set(opts.types ?? ['TaintedValue', 'Untrusted']);
    const check = (node) => {
      const ann = node.typeAnnotation;
      const refs = [];
      const visit = (t) => {
        if (!t) return;
        if (t.type === 'TSTypeReference') {
          if (t.typeName.type === 'Identifier') refs.push(t.typeName.name);
          (t.typeArguments?.params ?? t.typeParameters?.params ?? []).forEach(visit);
        } else if (t.type === 'TSArrayType') visit(t.elementType);
        else if (t.type === 'TSUnionType' || t.type === 'TSIntersectionType') t.types.forEach(visit);
      };
      visit(ann);
      const hit = refs.find((r) => types.has(r));
      if (hit) context.report({ node, messageId: 'cast', data: { name: hit } });
    };
    return { TSAsExpression: check, TSTypeAssertion: check, TSSatisfiesExpression: check };
  },
};
