'use client';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, Td, Th } from '@/components/ui/table';
import { msText, pct, useQuality } from '@/lib/approvals';

/**
 * OVERSIGHT QUALITY — docs/module8.md §5.6 (T12). Per approver, per week: how fast, whether the
 * evidence was opened on high-risk items, how often they edit or reject. A flag is a PRODUCT
 * signal — the packets are too noisy or the routing is wrong — not a mark against a person: the
 * first question is "why are they getting so many of these", not "why aren't they reading".
 * Target: evidence opened on more than 60% of HIGH/CRITICAL items.
 */
const FLAG: Record<string, string> = {
  IMPLAUSIBLE_SPEED: 'Decided faster than the packets can be read',
  NO_EVIDENCE_REVIEW: 'High-risk items approved without opening the evidence',
};

export default function ApprovalQualityPage() {
  const q = useQuality();
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-0.5">
          <CardTitle>Oversight quality</CardTitle>
          <CardDescription>Is human oversight genuine (EU AI Act Art. 14)? Computed nightly from every decision. A flag means: look at the packets and the routing first.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {q.error ? <ErrorText error={q.error} /> : null}
        <Table data-testid="approval-quality">
          <thead>
            <tr>
              <Th>Approver</Th>
              <Th>Week of</Th>
              <Th className="text-right">Decisions</Th>
              <Th className="text-right">Median</Th>
              <Th className="text-right">p10</Th>
              <Th className="text-right">Evidence opened (high risk)</Th>
              <Th className="text-right">Edited</Th>
              <Th className="text-right">Rejected</Th>
              <Th>Signal</Th>
            </tr>
          </thead>
          <tbody>
            {(q.data ?? []).map((r) => (
              <tr key={`${r.approverId}-${r.windowStart}`}>
                <Td>{r.approver}</Td>
                <Td className="text-xs">{r.windowStart}</Td>
                <Td className="text-right tabular-nums">{r.decisions}</Td>
                <Td className="text-right tabular-nums">{msText(r.medianLatencyMs)}</Td>
                <Td className="text-right tabular-nums">{msText(r.p10LatencyMs)}</Td>
                <Td className="text-right tabular-nums">
                  {pct(r.evidenceOpenRate)} ({pct(r.highEvidenceOpenRate)})
                </Td>
                <Td className="text-right tabular-nums">{pct(r.editRate)}</Td>
                <Td className="text-right tabular-nums">{pct(r.rejectRate)}</Td>
                <Td>{r.flag ? <Badge tone="danger">{FLAG[r.flag] ?? r.flag}</Badge> : <span className="text-xs text-muted">—</span>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {q.data && !q.data.length ? <p className="p-4 text-sm text-muted">No decisions in the last 30 days.</p> : null}
      </CardContent>
    </Card>
  );
}
