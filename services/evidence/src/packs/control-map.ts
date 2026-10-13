/**
 * `control-map.md` (module7.md §5.6, PROJECT.md §23): which regulatory controls each kind of
 * entry in the pack evidences, with the pack's own counts — so an auditor reading the pack
 * knows what each file is evidence OF, not just what it contains.
 *
 * Wording discipline (§13): "tamper-evident", never "tamper-proof".
 */

interface Control {
  ref: string;
  requirement: string;
  how: string;
}

const AI_ACT_12: Control = { ref: 'EU AI Act Art. 12', requirement: 'Automatic recording of events (logging) over the system’s lifetime; traceability', how: 'Every consequential action is recorded before it happens (`action.pre`) and after (`action.post`), hash-chained, signed (ML-DSA-65) and anchored. Retention ≥ 6 months (floor 180 days).' };
const AI_ACT_14: Control = { ref: 'EU AI Act Art. 14', requirement: 'Effective human oversight; ability to intervene, override, interrupt', how: 'Approval and hold blocks in each receipt record who could intervene and what happened; revocations and undos are their own entries.' };
const AI_ACT_15: Control = { ref: 'EU AI Act Art. 15', requirement: 'Accuracy, robustness and cybersecurity', how: 'Taint violations, policy denials and fail-closed decisions are recorded; deterministic replay re-checks the decision layers.' };
const AI_ACT_26: Control = { ref: 'EU AI Act Art. 26', requirement: 'Deployer obligations: monitoring, keeping the logs generated', how: 'This pack is the export of those logs for the period, verifiable offline.' };
const AI_ACT_73: Control = { ref: 'EU AI Act Art. 73', requirement: 'Serious-incident reporting; preservation of evidence', how: 'Compensation failures and taint violations are chain entries; the chain cannot be altered without detection.' };
const FINRA_3110: Control = { ref: 'FINRA Rule 3110 / 2210', requirement: 'Supervision; principal review of communications with the public', how: 'Receipts carry the policy that required review, the approver role and the outcome.' };
const SEC_17A4: Control = { ref: 'SEC Rule 17a-4(f)', requirement: 'Books and records in a non-rewriteable, non-erasable form', how: 'Packs are written to WORM object storage; the chain itself is append-only at four layers and externally anchored.' };
const GDPR_17: Control = { ref: 'GDPR Art. 17 / Art. 30', requirement: 'Right to erasure; records of processing', how: 'The chain commits to digests only. Erasure removes plaintext and is itself recorded (`redaction`); the entries still verify.' };
const NIST: Control = { ref: 'NIST AI RMF (Govern, Manage)', requirement: 'Policies in force, risk measured and managed', how: 'Policy activations carry the policy documents; each receipt carries its risk score, tier and weights version.' };

const BY_KIND: Record<string, { what: string; controls: Control[] }> = {
  'action.pre': { what: 'An action about to be taken: who, which tool, the decision and its inputs (digests)', controls: [AI_ACT_12, AI_ACT_14, FINRA_3110, SEC_17A4, NIST] },
  'action.post': { what: 'What the action did: committed, failed or unknown, with a digest of the result', controls: [AI_ACT_12, SEC_17A4] },
  approval: { what: 'A human approval decision and what the approver saw', controls: [AI_ACT_14, FINRA_3110] },
  hold: { what: 'A held action: released, revoked or edited', controls: [AI_ACT_14] },
  'compensation.succeeded': { what: 'An action undone', controls: [AI_ACT_14, AI_ACT_73] },
  'compensation.failed': { what: 'An undo that failed (an incident)', controls: [AI_ACT_73, AI_ACT_15] },
  'policy.activated': { what: 'A policy bundle going live, with every policy document in it', controls: [NIST, FINRA_3110] },
  'autonomy.changed': { what: 'An agent’s autonomy tier changing', controls: [AI_ACT_14, NIST] },
  'certification.completed': { what: 'A signed certification report: the evidence a workflow was promoted on (or held back by)', controls: [AI_ACT_14, AI_ACT_15, NIST] },
  admin: { what: 'An administrative change', controls: [AI_ACT_12] },
  'taint.violation': { what: 'Untrusted content blocked from reaching a tool', controls: [AI_ACT_15, AI_ACT_73] },
  'run.program': { what: 'The plan a run executed (program digest, pinned model)', controls: [AI_ACT_12] },
  redaction: { what: 'Plaintext erased under a recorded request; the digest remains', controls: [GDPR_17] },
  'evidence.pack_built': { what: 'An evidence pack was built (every export is itself evidence)', controls: [AI_ACT_26] },
  'replay.recorded': { what: 'A deterministic replay of a past decision and its result', controls: [AI_ACT_15] },
};

export function controlMap(input: { tenantSlug: string; query: Record<string, unknown>; counts: Record<string, number>; builtAt: string }): string {
  const lines: string[] = [];
  lines.push(`# Control map — ${input.tenantSlug}`, '');
  lines.push(`Built ${input.builtAt}. Query: \`${JSON.stringify(input.query)}\`.`, '');
  lines.push('Each entry kind in `entries.jsonl`, how many this pack holds, and the controls it evidences.', '');
  lines.push('| Entry kind | In this pack | What it records | Controls |', '|---|---:|---|---|');
  const kinds = [...new Set([...Object.keys(BY_KIND), ...Object.keys(input.counts)])];
  for (const k of kinds) {
    const m = BY_KIND[k];
    lines.push(`| \`${k}\` | ${input.counts[k] ?? 0} | ${m?.what ?? 'Platform event'} | ${m ? m.controls.map((c) => c.ref).join('; ') : '—'} |`);
  }
  lines.push('', '## Controls', '');
  const all = new Map<string, Control>();
  for (const m of Object.values(BY_KIND)) for (const c of m.controls) all.set(c.ref, c);
  for (const c of all.values()) lines.push(`### ${c.ref}`, '', `**Requirement.** ${c.requirement}`, '', `**How this pack evidences it.** ${c.how}`, '');
  lines.push('## What this pack does not claim', '');
  lines.push('- The chain is **tamper-evident**, not tamper-proof: a change is detectable by the checks in `verifier/`, not impossible.');
  lines.push('- Approval receipts record the approver role and outcome; the digest of exactly what the approver saw (`evidence_digest`) is recorded where approval capture supplies it.');
  lines.push('- Redacted content is absent by design; its digest and the redaction record are present.');
  return `${lines.join('\n')}\n`;
}

export function packReadme(input: { tenantSlug: string; packId: string; entryCount: number; builtAt: string; publicBase: string | null }): string {
  const anchors = input.publicBase ? `${input.publicBase}/.well-known/vega/anchors/${input.tenantSlug}` : '/.well-known/vega/anchors/<tenant>';
  const keys = input.publicBase ? `${input.publicBase}/.well-known/vega/keys` : '/.well-known/vega/keys';
  return `# Evidence pack ${input.packId}

${input.entryCount} chain entries for **${input.tenantSlug}**, built ${input.builtAt}.

## Verify it yourself — offline, without contacting us

You need Node.js 20 or later and nothing else. The verifier in \`verifier/\` is open source
(Apache-2.0) and makes no network calls.

\`\`\`
node verifier/vega-verify.mjs .
\`\`\`

(or point it at the zip: \`node verifier/vega-verify.mjs evidence-pack.zip\`). It checks:

1. the manifest signature, and that every file matches the digest the manifest lists;
2. that the entries are exactly the ones the manifest names, in sequence;
3. that every entry hashes to its \`entry_hash\` and is signed (ML-DSA-65, FIPS 204);
4. the hash chain between consecutive entries;
5. every signed tree head, inclusion of every entry in the log, and consistency between heads;
6. that redaction records match their chain entries, and included content matches its digest.

## Pin the keys and anchors independently

A pack can only vouch for itself. To check it against what we published — rather than what the
pack says — fetch the keys and the published tree heads and pass them in:

\`\`\`
curl -s ${keys} > keys.json
curl -s ${anchors} > anchors.json
node verifier/vega-verify.mjs . --keys keys.json --anchors anchors.json
\`\`\`

A tree head that matches the published one proves the log was not rewritten after it was
published — including by us.

## Files

| File | What |
|---|---|
| \`manifest.json\` | Query, counts, the digest of every file, signed |
| \`entries.jsonl\` | The chain entries, in sequence |
| \`anchors.json\` | Signed tree heads |
| \`keys.json\` | The public keys that signed |
| \`proofs/inclusion.json\` | RFC 6962 inclusion proof per entry |
| \`proofs/consistency.json\` | Consistency proofs between tree heads |
| \`policies/\` | Every policy version in force during the window |
| \`approvals/\` | Approval receipts |
| \`models.json\` | Model and prompt versions used |
| \`control-map.md\` | Entry kinds → regulatory controls |
| \`redactions.json\` | What was erased, when, under which request |
| \`content/\` | Content the requester was permitted to include, by digest |
| \`verifier/\` | The standalone verifier, its license and specification |
`;
}
