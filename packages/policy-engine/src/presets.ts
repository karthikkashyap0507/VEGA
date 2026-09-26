import { parsePolicyYaml, type Policy } from './schema.js';

/**
 * PRESET MODES — docs/module5.md §5.7. Self-serve users never author YAML: they pick a mode, and
 * the mode is YAML compiled to the same kind of bundle the enterprise path produces (D-09: one
 * engine, different exposure). Hard gates and the HIGH/CRITICAL tier floors apply identically in
 * every mode; a preset relaxes DEFAULTS only, and no preset permits an untrusted recipient.
 *
 * Tenants that author policies get the preset of their choice (default: balanced) as well —
 * both are evaluated and the most restrictive result wins.
 */

const SHARED = `
- id: untrusted-recipient-block
  description: A recipient derived from untrusted content is never permitted
  citation: internal-sec-001
  severity: critical
  when:
    all:
      - tool.egress_class: { in: [EXTERNAL, PUBLIC] }
      - args.recipient.taint: { not: TRUSTED }
  then:
    decision: DENY
    reason: Recipients must be people you named or entities your organization trusts
- id: budget-exhausted
  description: Over the monthly budget nothing more runs — it queues, it never bills a surprise
  severity: high
  when: { budget.exhausted: true }
  then:
    decision: DENY
    reason: The monthly budget is spent; raise it or wait for the next period
- id: reads-automatic
  description: Reading changes nothing
  severity: low
  when: { tool.reversibility: R0 }
  then: { decision: ALLOW }
`;

export const PRESET_YAML = {
  cautious: `${SHARED}
- id: internal-undoable-hold
  description: Internal changes wait a minute before they happen
  severity: normal
  when:
    all: [{ tool.egress_class: INTERNAL }, { tool.reversibility: R1 }]
  then: { decision: ALLOW_WITH_HOLD, hold_window: 1m }
- id: internal-final-approval
  description: Internal changes that cannot be fully undone need approval
  severity: high
  when:
    all: [{ tool.egress_class: INTERNAL }, { tool.reversibility: { in: [R2, R3] } }]
  then: { decision: REQUIRE_APPROVAL, approver_role: APPROVER }
- id: external-approval
  description: Everything that leaves the organization needs approval, then a hold
  severity: high
  when: { tool.egress_class: { in: [EXTERNAL, PUBLIC] } }
  then: { decision: REQUIRE_APPROVAL, approver_role: APPROVER, hold_window: 5m }
`,
  balanced: `${SHARED}
- id: internal-undoable-automatic
  description: Internal actions that can be undone completely run without waiting
  severity: low
  when:
    all: [{ tool.egress_class: INTERNAL }, { tool.reversibility: R1 }]
  then: { decision: ALLOW }
- id: external-send-hold
  description: Anything leaving the organization is held with a window to pull it back
  severity: normal
  when: { tool.egress_class: { in: [EXTERNAL, PUBLIC] } }
  then: { decision: ALLOW_WITH_HOLD, hold_window: 2m }
`,
  fast: `${SHARED}
- id: internal-automatic
  description: Internal actions run without waiting
  severity: low
  when: { tool.egress_class: INTERNAL }
  then: { decision: ALLOW }
- id: external-brief-hold
  description: Anything leaving the organization is held briefly
  severity: normal
  when: { tool.egress_class: { in: [EXTERNAL, PUBLIC] } }
  then: { decision: ALLOW_WITH_HOLD, hold_window: 30s }
`,
} as const;

export type PresetMode = keyof typeof PRESET_YAML;
export const PRESET_MODES = Object.keys(PRESET_YAML) as PresetMode[];
export const PRESET_VERSION = 1;

export function presetPolicies(mode: PresetMode): Array<{ policy: Policy; version: number }> {
  return parsePolicyYaml(PRESET_YAML[mode]).map((policy) => ({ policy, version: PRESET_VERSION }));
}

/**
 * The BEACHHEAD VERTICAL PACK — professional services (law, accounting, advisory): client
 * confidentiality, personal data, money, credentials, and human oversight of what cannot be
 * undone, each with the rule it answers to. Tenants adopt it as their own policies (versioned,
 * simulated, activated like any other).
 */
export const PROFESSIONAL_SERVICES_PACK = `
- id: client-confidentiality
  description: Confidential client material leaves the firm only with a reviewer's approval
  citation: ABA Model Rule 1.6
  severity: high
  when:
    all:
      - data.labels: { contains: CONFIDENTIAL }
      - tool.egress_class: { in: [EXTERNAL, PUBLIC] }
  then: { decision: REQUIRE_APPROVAL, approver_role: APPROVER, hold_window: 15m, evidence: [draft_body, source_provenance] }
- id: personal-data-to-non-clients
  description: Personal data goes to someone other than a known client only with approval
  citation: GDPR Art. 5(1)(f)
  severity: high
  when:
    all:
      - data.labels: { contains: PII }
      - target.audience: { in: [EXTERNAL, PUBLIC] }
  then: { decision: REQUIRE_APPROVAL, approver_role: APPROVER }
- id: health-data-never-external
  description: Health information never leaves in a message
  citation: HIPAA 45 CFR 164.502
  severity: critical
  when:
    all:
      - data.labels: { contains: PHI }
      - tool.egress_class: { in: [EXTERNAL, PUBLIC] }
  then: { decision: DENY, reason: "Health information must go through the records system, not a message" }
- id: credentials-never-sent
  description: Credentials never leave in a message, draft or post
  citation: internal-sec-002
  severity: critical
  when: { data.labels: { contains: SECRET } }
  then: { decision: DENY, reason: "A credential was detected in the content; remove it and rotate it" }
- id: large-value-dual-approval
  description: Anything moving 10,000 or more needs two approvers, neither of them the requester
  citation: SOC 2 CC5.3 (segregation of duties)
  severity: critical
  when: { effect.monetary_value.amount: { gte: 10000 } }
  then: { decision: REQUIRE_DUAL_APPROVAL, approver_role: ADMIN, separation_of_duties: true }
- id: irreversible-human-oversight
  description: Actions that cannot be undone are decided by a person
  citation: EU AI Act Art. 14
  severity: high
  when: { tool.reversibility: R3 }
  then: { decision: REQUIRE_APPROVAL, approver_role: APPROVER }
- id: first-contact-hold
  description: A first message to someone outside the firm and its client list waits ten minutes
  citation: internal-ops-004
  severity: normal
  when:
    all:
      - target.audience: EXTERNAL
      - tool.egress_class: EXTERNAL
  then: { decision: ALLOW_WITH_HOLD, hold_window: 10m }
`;
