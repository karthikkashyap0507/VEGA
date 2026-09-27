'use client';
import { RiskBadge } from '@/components/ui/risk-badge';
import { cn } from '@/lib/utils';
import { DECISION_TEXT, durationText, type ChainStep, type Evaluation, type RiskFactorLine } from '@/lib/policy';

/**
 * RISK EXPLANATION PANEL — docs/module5.md §6.3. Rendered on the action card (M4), and ready for
 * the approval packet (M8) and the audit entry (M7): every factor as a number, a bar AND a
 * sentence — never colour alone (these screens end up printed in compliance evidence).
 */

const LABEL: Record<RiskFactorLine['factor'], string> = {
  externalExposure: 'External exposure',
  irreversibility: 'Irreversibility',
  taintPressure: 'Taint pressure',
  dataSensitivity: 'Data sensitivity',
  blastRadius: 'Blast radius',
  authorityGap: 'Authority gap',
  certificationCredit: 'Certification credit',
};

function Bar({ value }: { value: number }) {
  const filled = Math.round(Math.max(0, Math.min(100, value)) / 10);
  return (
    <span className="font-mono tracking-tighter" aria-hidden>
      {'█'.repeat(filled)}
      <span className="text-muted">{'░'.repeat(10 - filled)}</span>
    </span>
  );
}

export function FactorTable({ lines }: { lines: RiskFactorLine[] }) {
  const ordered = [...lines].sort((a, b) => b.contribution - a.contribution);
  return (
    <table className="w-full text-xs" aria-label="Risk factors">
      <tbody>
        {ordered.map((l) => (
          <tr key={l.factor} className="align-baseline">
            <th scope="row" className="whitespace-nowrap py-0.5 pr-3 text-left font-normal">
              {LABEL[l.factor]}
            </th>
            <td className="w-8 py-0.5 pr-2 text-right tabular-nums" aria-label={`${l.value} of 100`}>
              {Math.round(l.value)}
            </td>
            <td className="py-0.5 pr-3">
              <Bar value={l.value} />
            </td>
            <td className="py-0.5 text-muted">{l.text}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ReasonChain({ chain, className }: { chain: ChainStep[]; className?: string }) {
  return (
    <ol className={cn('grid gap-0.5 text-xs', className)} aria-label="Reason chain">
      {chain.map((s, i) => (
        <li key={i} className="grid grid-cols-[5.5rem_1fr] gap-2">
          <span className="font-mono uppercase text-muted">{s.step}</span>
          <span>
            {s.detail}
            {s.citation && !s.detail.includes(s.citation) ? <span className="text-muted"> ({s.citation})</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function RiskExplanation({ evaluation }: { evaluation: Evaluation }) {
  const r = evaluation.risk;
  const policyStep = evaluation.chain.find((s) => s.step === 'policy' && s.id === evaluation.decidedBy.key);
  return (
    <section className="grid gap-2 rounded-md border border-border bg-surface-muted/60 p-2" aria-label="Risk explanation" data-testid="risk-explanation">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        {r ? (
          <>
            <RiskBadge tier={r.tier} />
            <span className="tabular-nums">score {r.score}</span>
            {r.tier !== r.scoreTier ? <span className="text-xs text-muted">(raised from {r.scoreTier} by a hard gate)</span> : null}
          </>
        ) : null}
        <span className="text-xs font-semibold">{DECISION_TEXT[evaluation.decision]}</span>
        {evaluation.failClosed ? <span className="text-xs text-risk-critical">the policy engine could not decide — denied (fail closed)</span> : null}
      </header>
      {r?.explanation.length ? <FactorTable lines={r.explanation} /> : null}
      {r?.hardGates.length ? <p className="text-xs">Hard gates: {r.hardGates.join(', ')} — no score can override these.</p> : null}
      <p className="text-xs">
        {policyStep ? (
          <>
            Policy: <span className="font-medium">{policyStep.id}</span>
            {policyStep.citation ? ` (${policyStep.citation})` : ''} →{' '}
          </>
        ) : (
          <>Decided by {evaluation.decidedBy.key} → </>
        )}
        {DECISION_TEXT[evaluation.decision].toLowerCase()}
        {evaluation.approverRole ? `, by ${evaluation.approverRole}` : ''}
        {evaluation.holdWindowMs ? `, ${durationText(evaluation.holdWindowMs)} hold window` : ''}.
      </p>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted">
          Reason chain · {evaluation.preset} preset{evaluation.bundleVersion ? ` · tenant bundle v${evaluation.bundleVersion}` : ''} · weights v{r?.weightsVersion ?? '–'}
        </summary>
        <ReasonChain chain={evaluation.chain} className="mt-1" />
      </details>
    </section>
  );
}
