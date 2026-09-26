import { docs } from '../util.js';

/**
 * Decision D-09 (PROJECT.md §22.1): "Every tier runs the same engine. Tiers differ only in
 * what is exposed, never in what is built." A comparison against a plan NAME is a second code
 * path — the failure mode this constraint exists to prevent. Entitlements are data: read
 * `plan_entitlements.exposed`/`limits`, never branch on 'enterprise'.
 */
const PLANS = new Set(['free', 'pro', 'business', 'teams', 'enterprise']);

function isPlanRef(node) {
  if (!node) return false;
  if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    return node.property.name === 'plan';
  }
  return node.type === 'Identifier' && node.name === 'plan';
}

export default {
  meta: {
    type: 'problem',
    docs: docs('No branching on a plan name', 'PROJECT.md#221-the-subset-architecture-constraint-binding-on-all-modules'),
    schema: [],
    messages: {
      branch:
        'TIERS ARE DATA (PROJECT.md §22.1, D-09): comparing a plan to "{{plan}}" creates a second code path. Gate EXPOSURE with plan_entitlements, never behaviour.',
    },
  },
  create(context) {
    const check = (a, b, node) => {
      const lit = b?.type === 'Literal' && typeof b.value === 'string' && PLANS.has(b.value) ? b.value : undefined;
      if (lit && isPlanRef(a)) context.report({ node, messageId: 'branch', data: { plan: lit } });
    };
    return {
      BinaryExpression(node) {
        if (!['===', '!==', '==', '!='].includes(node.operator)) return;
        check(node.left, node.right, node);
        check(node.right, node.left, node);
      },
      SwitchStatement(node) {
        if (!isPlanRef(node.discriminant)) return;
        for (const c of node.cases) check(node.discriminant, c.test, c);
      },
    };
  },
};
