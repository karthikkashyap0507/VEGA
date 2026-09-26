# GENERATED from YAML policies by @vega/policy-engine — never edit by hand.

package vega.packs.professional_services

import rego.v1

# client-confidentiality v1 — ABA Model Rule 1.6
# Confidential client material leaves the firm only with a reviewer's approval

matches contains {"approver_role": "APPROVER", "citation": "ABA Model Rule 1.6", "decision": "REQUIRE_APPROVAL", "hold_window_ms": 900000, "id": "client-confidentiality", "reason": null, "separation_of_duties": false, "severity": "high", "version": 1} if {
	is_array(input.data.labels)
	"CONFIDENTIAL" in input.data.labels
	input.tool.egress_class in {"EXTERNAL", "PUBLIC"}
}

# credentials-never-sent v1 — internal-sec-002
# Credentials never leave in a message, draft or post

matches contains {"approver_role": null, "citation": "internal-sec-002", "decision": "DENY", "hold_window_ms": null, "id": "credentials-never-sent", "reason": "A credential was detected in the content; remove it and rotate it", "separation_of_duties": false, "severity": "critical", "version": 1} if {
	is_array(input.data.labels)
	"SECRET" in input.data.labels
}

# first-contact-hold v1 — internal-ops-004
# A first message to someone outside the firm and its client list waits ten minutes

matches contains {"approver_role": null, "citation": "internal-ops-004", "decision": "ALLOW_WITH_HOLD", "hold_window_ms": 600000, "id": "first-contact-hold", "reason": null, "separation_of_duties": false, "severity": "normal", "version": 1} if {
	input.target.audience == "EXTERNAL"
	input.tool.egress_class == "EXTERNAL"
}

# health-data-never-external v1 — HIPAA 45 CFR 164.502
# Health information never leaves in a message

matches contains {"approver_role": null, "citation": "HIPAA 45 CFR 164.502", "decision": "DENY", "hold_window_ms": null, "id": "health-data-never-external", "reason": "Health information must go through the records system, not a message", "separation_of_duties": false, "severity": "critical", "version": 1} if {
	is_array(input.data.labels)
	"PHI" in input.data.labels
	input.tool.egress_class in {"EXTERNAL", "PUBLIC"}
}

# irreversible-human-oversight v1 — EU AI Act Art. 14
# Actions that cannot be undone are decided by a person

matches contains {"approver_role": "APPROVER", "citation": "EU AI Act Art. 14", "decision": "REQUIRE_APPROVAL", "hold_window_ms": null, "id": "irreversible-human-oversight", "reason": null, "separation_of_duties": false, "severity": "high", "version": 1} if {
	input.tool.reversibility == "R3"
}

# large-value-dual-approval v1 — SOC 2 CC5.3 (segregation of duties)
# Anything moving 10,000 or more needs two approvers, neither of them the requester

matches contains {"approver_role": "ADMIN", "citation": "SOC 2 CC5.3 (segregation of duties)", "decision": "REQUIRE_DUAL_APPROVAL", "hold_window_ms": null, "id": "large-value-dual-approval", "reason": null, "separation_of_duties": true, "severity": "critical", "version": 1} if {
	is_number(input.effect.monetary_value.amount)
	input.effect.monetary_value.amount >= 10000
}

# personal-data-to-non-clients v1 — GDPR Art. 5(1)(f)
# Personal data goes to someone other than a known client only with approval

matches contains {"approver_role": "APPROVER", "citation": "GDPR Art. 5(1)(f)", "decision": "REQUIRE_APPROVAL", "hold_window_ms": null, "id": "personal-data-to-non-clients", "reason": null, "separation_of_duties": false, "severity": "high", "version": 1} if {
	is_array(input.data.labels)
	"PII" in input.data.labels
	input.target.audience in {"EXTERNAL", "PUBLIC"}
}
