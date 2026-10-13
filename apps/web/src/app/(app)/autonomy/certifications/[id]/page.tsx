'use client';
import { Check, Printer, X } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ErrorText } from '@/components/error-text';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, Td, Th } from '@/components/ui/table';
import { pct, TIER_TEXT, useReport } from '@/lib/autonomy';

/**
 * THE CERTIFICATION REPORT — docs/module10.md §15.2: the full report as it was signed and filed.
 * Agreement, edit rate, the error taxonomy with examples, pinned versions, the recommendation —
 * every number is plain arithmetic over the override corpus, so a risk committee can recompute
 * it. "Print" produces the committee's copy; the signed original is the evidence-chain entry
 * named at the bottom, verifiable with the evidence verifier.
 */

const CLASS_TEXT: Record<string, string> = {
  content_edit: 'Content edited before release',
  wrong_recipient: 'Wrong recipient',
  tone_mismatch: 'Tone mismatch',
  missing_context: 'Missing context',
  unsupported_claim: 'Unsupported claim',
  rejected_other: 'Rejected (other)',
  taint_violation: 'Untrusted content reached a tool',
  compensation_failed: 'An undo of this action failed',
  verification_abort: 'Stopped by verification before release',
  post_commit_verification_failure: 'Failed verification after release',
};

const REC: Record<string, { text: string; tone: 'success' | 'danger' | 'neutral' }> = {
  PROMOTE: { text: 'Promote — every condition holds', tone: 'success' },
  HOLD: { text: 'Hold — not enough evidence yet, or a threshold missed', tone: 'neutral' },
  DEMOTE: { text: 'Demote — the history itself shows harm', tone: 'danger' },
};

export default function CertificationReportPage() {
  const { id } = useParams<{ id: string }>();
  const report = useReport(id);
  const r = report.data;
  return (
    <article className="mx-auto grid w-full max-w-3xl gap-5 print:max-w-none">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link href="/autonomy" className="text-sm text-primary hover:underline">
          ← Autonomy
        </Link>
        <Button size="sm" variant="secondary" onClick={() => window.print()} disabled={!r}>
          <Printer aria-hidden /> Print / save as PDF
        </Button>
      </div>
      {report.error ? <ErrorText error={report.error} /> : null}
      {r ? (
        <>
          <header className="grid gap-1 border-b border-border pb-3">
            <p className="text-xs uppercase tracking-wide text-muted">Certification report</p>
            <h1 className="text-xl font-semibold">
              <span className="font-mono text-base">{r.actionType}</span>
            </h1>
            <p className="text-sm text-muted">
              Window {new Date(r.window.from).toLocaleDateString()} – {new Date(r.window.to).toLocaleDateString()} · filed {new Date(r.createdAt).toLocaleString()} · currently{' '}
              <strong>{TIER_TEXT[r.fromTier].label}</strong>
            </p>
          </header>

          <section aria-label="Recommendation" className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={REC[r.recommendation]!.tone}>{r.recommendation}</Badge>
              <span className="text-sm">
                {REC[r.recommendation]!.text}
                {r.recommendedTier ? ` → ${TIER_TEXT[r.recommendedTier].label}` : ''}
              </span>
            </div>
            <p className="text-xs text-muted">
              A recommendation is not a promotion. Only a person’s ratification moves the tier, and the gate is checked again at that moment.
              {r.ratification ? ` Ratified ${new Date(r.ratification.at).toLocaleString()}.` : ' Not ratified.'}
            </p>
          </section>

          <section aria-label="Scores" className="grid gap-3 sm:grid-cols-4">
            {[
              ['Decisions sampled', String(r.sampleSize)],
              ['Agreement', pct(r.agreementRate, 1)],
              ['Edit rate', pct(r.editRate, 1)],
              ['Critical errors', String(r.criticalErrors)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-border px-3 py-2">
                <p className="text-xs text-muted">{label}</p>
                <p className="text-xl font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </section>
          <p className="-mt-3 text-xs text-muted">
            Agreement = decisions approved with no edit ÷ decisions. Edit rate = decisions edited ÷ decisions. A critical error is counted, never averaged away.
          </p>

          <section aria-label="Gate" className="grid gap-2">
            <h2 className="text-sm font-semibold">The promotion gate</h2>
            <ul className="grid gap-1.5">
              {r.gate.map((g) => (
                <li key={g.name} className="flex items-start gap-2 text-sm">
                  {g.pass ? <Check aria-label="passes" className="mt-0.5 size-4 shrink-0 text-success" /> : <X aria-label="fails" className="mt-0.5 size-4 shrink-0 text-danger" />}
                  <span>
                    <span className="font-medium">{g.name}</span> <span className="text-muted">— {g.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section aria-label="Error taxonomy" className="grid gap-2">
            <h2 className="text-sm font-semibold">Where the approvers disagreed</h2>
            {r.errorTaxonomy.length ? (
              <Table>
                <thead>
                  <tr>
                    <Th>Class</Th>
                    <Th className="text-right">Count</Th>
                    <Th>Severity</Th>
                    <Th>Examples</Th>
                  </tr>
                </thead>
                <tbody>
                  {r.errorTaxonomy.map((c) => (
                    <tr key={c.key}>
                      <Td>{CLASS_TEXT[c.key] ?? c.key.replace(/_/g, ' ')}</Td>
                      <Td className="text-right tabular-nums">{c.count}</Td>
                      <Td>{c.critical ? <Badge tone="danger">critical</Badge> : <span className="text-xs text-muted">minor</span>}</Td>
                      <Td className="text-xs text-muted">
                        {c.examples.map((e) => (
                          <div key={e.decisionId}>
                            {e.note} <span className="font-mono">({e.decisionId.slice(0, 8)})</span>
                          </div>
                        ))}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-sm text-muted">No disagreements in this window.</p>
            )}
          </section>

          <section aria-label="Pinned versions" className="grid gap-1">
            <h2 className="text-sm font-semibold">What this certification covers</h2>
            <p className="text-sm">
              Connector: {Object.entries(r.pinned.connectorVersions).map(([k, v]) => `${k} v${v}`).join(', ') || '—'}
            </p>
            <p className="text-sm">Planning model(s): {r.pinned.modelVersions.join(', ') || 'none recorded'}</p>
            <p className="text-xs text-muted">If any of these changes, the certification no longer describes what runs and the action falls back to Supervised automatically.</p>
          </section>

          <footer className="grid gap-1 border-t border-border pt-3 text-xs text-muted">
            <p>
              Signed: evidence-chain entry <span className="font-mono">{r.signed.reportRef.replace('evidence:', '')}</span>
            </p>
            <p className="break-all">
              Entry hash <span className="font-mono">{r.signed.entryHash}</span>
            </p>
            <p>{r.signed.note}</p>
          </footer>
        </>
      ) : null}
    </article>
  );
}
