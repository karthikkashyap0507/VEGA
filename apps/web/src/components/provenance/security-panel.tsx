import { TriangleAlert } from 'lucide-react';
import { ProvenanceChip, type Taint } from './taint';

export interface CallTraceView {
  nodeId: string;
  toolId: string;
  gate: 'PROCEED' | 'REQUIRE_APPROVAL' | 'VIOLATION';
  argTaint: Taint;
  argTaints: Array<{ path: string; taint: Taint; dataTaint: Taint; sourceIds: readonly string[] }>;
  executed: boolean;
}

/**
 * The security explanation panel — module3.md §8.2. Rendered on any action whose arguments
 * carry untrusted taint. Written for a CISO in a demo: every sentence is a mechanically true
 * statement about this call, derived from its trace — never marketing about the product.
 */
export function SecurityPanel({ call, recipientArgs }: { call: CallTraceView; recipientArgs: readonly string[] }) {
  if (call.argTaint === 'TRUSTED') return null;
  const untrusted = call.argTaints.filter((a) => a.taint === 'UNTRUSTED' || a.dataTaint === 'UNTRUSTED');
  const recips = call.argTaints.filter((a) => recipientArgs.some((r) => a.path === r || a.path.startsWith(`${r}[`) || a.path.startsWith(`${r}.`)));
  const sources = [...new Set(untrusted.flatMap((a) => a.sourceIds))].filter((s) => !s.startsWith('registry:'));
  const resolved = recips.some((r) => r.sourceIds.some((s) => s.startsWith('registry:')));
  return (
    <section aria-label="This action involves untrusted content" className="grid gap-2 rounded border border-taint-untrusted bg-taint-untrusted-bg/50 p-3 text-sm">
      <p className="flex items-center gap-2 font-semibold text-taint-untrusted">
        <TriangleAlert aria-hidden className="size-4" /> This action involves untrusted content
      </p>
      <p>
        <span className="font-mono text-xs">{call.toolId}</span> uses content derived from{' '}
        {sources.length ? sources.map((s) => <ProvenanceChip key={s} taint="UNTRUSTED" sourceIds={[s]} label={s} />) : 'outside your organization'}.
      </p>
      <ul className="grid list-disc gap-1 pl-5">
        {recips.length ? (
          <li>
            {recips.every((r) => r.dataTaint === 'TRUSTED')
              ? resolved
                ? 'The recipient was resolved from your trusted contacts — the content could only choose among people you already trust.'
                : 'The recipient was set by you, not by that content.'
              : 'The recipient was derived from untrusted content. This action is refused, and cannot be approved.'}
          </li>
        ) : null}
        <li>
          {untrusted.length} of {call.argTaints.length} argument{call.argTaints.length === 1 ? '' : 's'} ({untrusted.map((u) => u.path).join(', ') || 'the decision to act'}) came from untrusted content.
        </li>
        <li>
          {call.gate === 'VIOLATION'
            ? 'The platform blocked this action and recorded a security incident.'
            : call.gate === 'REQUIRE_APPROVAL'
              ? 'This action cannot be released without your approval.'
              : 'This action stays inside your organization and was allowed to proceed.'}
        </li>
      </ul>
    </section>
  );
}
