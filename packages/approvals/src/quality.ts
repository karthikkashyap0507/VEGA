/**
 * RUBBER-STAMP DETECTION — docs/module8.md §5.6, threat T12. An approval nobody read is worse
 * than none: it manufactures evidence of oversight. Per approver, per window:
 *
 *   IMPLAUSIBLE_SPEED   more than 1 in 10 decisions faster than the packet could be read
 *                       (p10 latency below plausible reading time)
 *   NO_EVIDENCE_REVIEW  on HIGH/CRITICAL items, the evidence was opened less than 60% of the time
 *
 * A flag is a PRODUCT signal for the compliance officer — the packets are too noisy, or the
 * routing is wrong — not a performance mark against a person (§5.6, §13).
 */

export interface DecisionSample {
  decision: string;
  latencyMs: number;
  evidenceOpened: boolean;
  edited: boolean;
  riskTier: string | null;
  packetChars: number;
}

/** How long reading a packet of this size plausibly takes: ~1 s to orient, then ~50 chars/s (a fast reader). */
export const plausibleReadMs = (chars: number) => 1_000 + chars * 20;

export const MIN_DECISIONS_FOR_FLAG = 5;
export const EVIDENCE_OPEN_TARGET = 0.6;

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
};

export interface QualityStats {
  decisions: number;
  medianLatencyMs: number;
  p10LatencyMs: number;
  evidenceOpenRate: number;
  highEvidenceOpenRate: number | null;
  editRate: number;
  rejectRate: number;
  tooFastRate: number;
  flag: 'IMPLAUSIBLE_SPEED' | 'NO_EVIDENCE_REVIEW' | null;
}

export function computeQuality(samples: DecisionSample[]): QualityStats {
  const real = samples.filter((s) => s.decision === 'approve' || s.decision === 'approve_with_edits' || s.decision === 'reject');
  const n = real.length;
  const rate = (f: (s: DecisionSample) => boolean, of = real) => (of.length ? of.filter(f).length / of.length : 0);
  const high = real.filter((s) => s.riskTier === 'HIGH' || s.riskTier === 'CRITICAL');
  const tooFastRate = rate((s) => s.latencyMs < plausibleReadMs(s.packetChars));
  const highRate = high.length ? rate((s) => s.evidenceOpened, high) : null;
  let flag: QualityStats['flag'] = null;
  if (n >= MIN_DECISIONS_FOR_FLAG && tooFastRate > 0.1) flag = 'IMPLAUSIBLE_SPEED';
  else if (high.length >= MIN_DECISIONS_FOR_FLAG && highRate !== null && highRate < EVIDENCE_OPEN_TARGET) flag = 'NO_EVIDENCE_REVIEW';
  return {
    decisions: n,
    medianLatencyMs: Math.round(quantile(real.map((s) => s.latencyMs), 0.5)),
    p10LatencyMs: Math.round(quantile(real.map((s) => s.latencyMs), 0.1)),
    evidenceOpenRate: rate((s) => s.evidenceOpened),
    highEvidenceOpenRate: highRate,
    editRate: rate((s) => s.edited),
    rejectRate: rate((s) => s.decision === 'reject'),
    tooFastRate,
    flag,
  };
}
