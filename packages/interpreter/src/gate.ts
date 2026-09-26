import type { ToolDeclarationRecord } from '@vega/contracts';
import { gt, isTainted, join, pressureOf, type Taint, type TaintedValue } from '@vega/taint';
import { underRecipient } from '@vega/dsl';

/**
 * THE TOOL GATE — docs/module3.md §7.3. Runs before every call, in this order:
 *
 *   0. provenance: every argument must be a value the taint module minted. Anything else — a
 *      forged object, a value that lost its label — FAILS CLOSED.
 *   1. recipient-class arguments must carry TRUSTED data. No exceptions and NO approval path:
 *      a human approving "send this to the address the attacker wrote" is exactly the failure
 *      approval cannot fix, so the gate refuses rather than escalates.
 *   2. aggregate taint (arguments + the control context) vs. the declared ceiling:
 *      INTERNAL tools → violation; EXTERNAL/PUBLIC tools → a human decides.
 *   3. otherwise PROCEED, handing taint pressure to policy (M5) as an input.
 */

export type GateDecision =
  | { decision: 'PROCEED'; argTaint: Taint; taintPressure: number }
  | { decision: 'REQUIRE_APPROVAL'; argTaint: Taint; taintPressure: number; reason: string }
  | {
      decision: 'VIOLATION';
      kind: 'RECIPIENT' | 'CEILING' | 'PROVENANCE';
      severity: 'HIGH' | 'CRITICAL';
      argPath: string;
      attemptedTaint: Taint;
      sourceIds: readonly string[];
      reason: string;
    };

export interface GateLeaf {
  path: string;
  value: TaintedValue;
}

export function gate(tool: ToolDeclarationRecord, leaves: readonly GateLeaf[], context: Taint): GateDecision {
  for (const l of leaves) {
    if (!isTainted(l.value)) {
      return { decision: 'VIOLATION', kind: 'PROVENANCE', severity: 'CRITICAL', argPath: l.path, attemptedTaint: 'UNTRUSTED', sourceIds: [], reason: 'argument without provenance' };
    }
  }
  for (const l of leaves) {
    if (tool.recipientArgs.some((r) => underRecipient(l.path, r)) && l.value.dataTaint !== 'TRUSTED') {
      return {
        decision: 'VIOLATION',
        kind: 'RECIPIENT',
        severity: 'CRITICAL',
        argPath: l.path,
        attemptedTaint: l.value.dataTaint,
        sourceIds: l.value.sourceIds,
        reason: `recipient ${l.path} is derived from ${l.value.dataTaint} content`,
      };
    }
  }
  const argTaint = join(context, ...leaves.map((l) => l.value.taint));
  if (gt(argTaint, tool.maxTaint)) {
    if (tool.egressClass === 'INTERNAL') {
      const worst = leaves.find((l) => gt(l.value.taint, tool.maxTaint));
      return {
        decision: 'VIOLATION',
        kind: 'CEILING',
        severity: 'HIGH',
        argPath: worst?.path ?? 'context',
        attemptedTaint: argTaint,
        sourceIds: [...new Set(leaves.flatMap((l) => l.value.sourceIds))].sort(),
        reason: `${tool.toolId} accepts at most ${tool.maxTaint}; arguments are ${argTaint}`,
      };
    }
    return { decision: 'REQUIRE_APPROVAL', argTaint, taintPressure: pressureOf(argTaint), reason: `${argTaint} content influences an ${tool.egressClass} action` };
  }
  return { decision: 'PROCEED', argTaint, taintPressure: pressureOf(argTaint) };
}
