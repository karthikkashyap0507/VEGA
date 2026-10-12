import { canonicalize, digestOf } from '@vega/verifier';

/**
 * THE DECISION PACKET — docs/module8.md §5.1. One screen: everything needed to decide, nothing
 * more. It is RENDERED HERE, server-side, as a canonical document, and hashed: the digest goes
 * into the approval decision and the Module 7 receipt (`evidence_digest`), so the chain proves
 * exactly what the approver was shown. The web and mobile surfaces are pure functions of it.
 *
 * Determinism (§9): no clock, no randomness, no environment — the same inputs give the same
 * bytes (RFC 8785, the verifier's own canonicalizer) and therefore the same digest, on any render.
 */

export const PACKET_VERSION = 1;

export type Fallback = 'AUTO_REJECT' | 'AUTO_APPROVE' | 'ESCALATE';

export interface PacketInput {
  request: {
    toolId: string;
    toolTitle: string;
    approverRole: string;
    approvalsRequired: number;
    separationOfDuties: boolean;
    expiresAt: string;
    fallback: Fallback;
    fallbackRole: string | null;
    urgency: 'normal' | 'urgent';
  };
  run: { id: string; objective: string; trigger: string; requestedBy: string; requestedByName: string | null; startedAt: string };
  action: {
    args: Record<string, unknown>;
    reversibility: string;
    egress: string;
    holdWindowMs: number | null;
    effect: { summary: string; externalRecipients: string[]; recordsAffected: unknown[]; fidelity: string } | null;
  };
  provenance: { argTaint: string; argTaints: Array<{ path: string; taint: string; dataTaint: string; sourceIds: readonly string[] }> };
  risk: { score: number | null; tier: string | null; factors?: Record<string, number> | null } | null;
  policy: { decision: string; decidedBy: string | null; reason: string | null; citation: string | null; chain: Array<{ step: string; detail: string; id?: string; version?: number; citation?: string | null }> };
  /** Module 9: the pre-commit checks and the claims no trusted source supports. */
  verification?: { outcome: string; checks: Array<{ check: string; outcome: string; detail: string }>; unsupportedClaims: Array<{ text: string; reason: string }> } | undefined;
}

export interface DecisionPacket {
  packet_version: typeof PACKET_VERSION;
  title: string;
  what: { summary: string; effects: Array<{ kind: 'recipient' | 'record'; value: string }>; reversibility: string; reversibility_text: string; egress: string; hold_window_ms: number | null; fidelity: string | null };
  why: { objective: string; trigger: string; reasoning: string };
  evidence: {
    sources: Array<{ id: string; taint: string; fields: string[] }>;
    untrusted_fields: string[];
    unsupported_claims: Array<{ text: string; reason: string }>;
    provenance_ref: string;
    content: Record<string, unknown>;
  };
  risk: { score: number | null; tier: string | null; factors: Record<string, number> };
  policy: { decision: string; id: string | null; citation: string | null; reason: string | null; reason_chain: Array<{ step: string; detail: string }> };
  routing: { approver_role: string; approvals_required: number; separation_of_duties: boolean };
  recommended: 'approve' | 'reject';
  /** Module 9 (present only when verification ran): the §8.3 panel, one line per check. */
  verification?: { outcome: string; checks: Array<{ check: string; outcome: string; detail: string }> };
  if_you_do_nothing: { at: string; fallback: Fallback; outcome: string };
  actions: string[];
}

const REVERSIBILITY_TEXT: Record<string, string> = {
  R0: 'Reads only: changes nothing',
  R1: 'Can be undone completely afterwards',
  R2: 'Can be pulled back while it is held; not after it is sent',
  R3: 'Cannot be undone',
};

export function outcomeIfNothing(fallback: Fallback, fallbackRole: string | null, toolId: string): string {
  switch (fallback) {
    case 'AUTO_APPROVE':
      return `Approved automatically (low risk, inside the organization) — ${toolId} runs`;
    case 'ESCALATE':
      return `Sent to ${fallbackRole ?? 'the next approver'} to decide — nothing runs until then`;
    default:
      return `Not done — ${toolId} will not run and the run ends`;
  }
}

/** Every string leaf, with its path — used to measure how much there is to read. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => strings(x, out));
  return out;
}

export function renderPacket(i: PacketInput): { packet: DecisionPacket; digest: string; readableChars: number } {
  const effects: DecisionPacket['what']['effects'] = [
    ...[...(i.action.effect?.externalRecipients ?? [])].sort().map((value) => ({ kind: 'recipient' as const, value })),
    ...(i.action.effect?.recordsAffected ?? []).map((r) => ({ kind: 'record' as const, value: typeof r === 'string' ? r : canonicalize(r) })).sort((a, b) => (a.value < b.value ? -1 : 1)),
  ];
  const sources = new Map<string, { taint: string; fields: Set<string> }>();
  for (const a of i.provenance.argTaints) {
    for (const s of a.sourceIds) {
      const e = sources.get(s) ?? { taint: a.dataTaint, fields: new Set<string>() };
      e.fields.add(a.path);
      sources.set(s, e);
    }
  }
  const untrusted = [...new Set(i.provenance.argTaints.filter((a) => a.dataTaint === 'UNTRUSTED' || a.taint === 'UNTRUSTED').map((a) => a.path))].sort();
  const decidedBy = i.policy.chain.find((s) => s.step === 'policy' && s.id === i.policy.decidedBy);
  const packet: DecisionPacket = {
    packet_version: PACKET_VERSION,
    title: i.action.effect?.summary ?? `${i.request.toolTitle} (${i.request.toolId})`,
    what: {
      summary: i.action.effect?.summary ?? i.request.toolTitle,
      effects,
      reversibility: i.action.reversibility,
      reversibility_text: REVERSIBILITY_TEXT[i.action.reversibility] ?? i.action.reversibility,
      egress: i.action.egress,
      hold_window_ms: i.action.holdWindowMs,
      fidelity: i.action.effect?.fidelity ?? null,
    },
    why: {
      objective: i.run.objective,
      trigger: `${i.run.trigger} · requested by ${i.run.requestedByName ?? i.run.requestedBy}`,
      reasoning: i.policy.reason ?? 'Policy requires a person to decide this.',
    },
    evidence: {
      sources: [...sources].map(([id, s]) => ({ id, taint: s.taint, fields: [...s.fields].sort() })).sort((a, b) => (a.id < b.id ? -1 : 1)),
      untrusted_fields: untrusted,
      // Module 9: the claims verification could not ground in a trusted source, highlighted.
      unsupported_claims: [...(i.verification?.unsupportedClaims ?? [])],
      provenance_ref: `/runs/${i.run.id}`,
      content: i.action.args,
    },
    risk: { score: i.risk?.score ?? null, tier: i.risk?.tier ?? null, factors: i.risk?.factors ?? {} },
    policy: {
      decision: i.policy.decision,
      id: i.policy.decidedBy,
      citation: i.policy.citation ?? decidedBy?.citation ?? null,
      reason: i.policy.reason,
      reason_chain: i.policy.chain.map((s) => ({ step: s.step, detail: s.detail })),
    },
    routing: { approver_role: i.request.approverRole, approvals_required: i.request.approvalsRequired, separation_of_duties: i.request.separationOfDuties },
    recommended: i.risk?.tier === 'CRITICAL' || i.verification?.checks.some((c) => c.outcome === 'ESCALATE' && c.check === 'groundedness') ? 'reject' : 'approve',
    ...(i.verification ? { verification: { outcome: i.verification.outcome, checks: i.verification.checks.map((c) => ({ check: c.check, outcome: c.outcome, detail: c.detail })) } } : {}),
    if_you_do_nothing: { at: i.request.expiresAt, fallback: i.request.fallback, outcome: outcomeIfNothing(i.request.fallback, i.request.fallbackRole, i.request.toolId) },
    actions: ['approve', 'approve_with_edits', 'reject', 'question'],
  };
  return { packet, digest: digestOf(canonicalize(packet)), readableChars: readableChars(packet) };
}

/** How much a stored packet asks a person to read (rubber-stamp plausibility, §5.6). */
export function readableChars(p: DecisionPacket): number {
  return strings([p.title, p.what, p.why, p.policy.reason, p.policy.citation, p.if_you_do_nothing.outcome, p.evidence.untrusted_fields]).join(' ').length;
}

/** The digest of a stored packet, recomputed (what a reader of the receipt can check). */
export const packetDigest = (packet: unknown): string => digestOf(canonicalize(packet));
