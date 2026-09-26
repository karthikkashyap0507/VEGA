# GENERATED from YAML policies by @vega/policy-engine — never edit by hand.

package vega.presets.balanced

import rego.v1

# budget-exhausted v1
# Over the monthly budget nothing more runs — it queues, it never bills a surprise

matches contains {"approver_role": null, "citation": null, "decision": "DENY", "hold_window_ms": null, "id": "budget-exhausted", "reason": "The monthly budget is spent; raise it or wait for the next period", "separation_of_duties": false, "severity": "high", "version": 1} if {
	input.budget.exhausted == true
}

# external-send-hold v1
# Anything leaving the organization is held with a window to pull it back

matches contains {"approver_role": null, "citation": null, "decision": "ALLOW_WITH_HOLD", "hold_window_ms": 120000, "id": "external-send-hold", "reason": null, "separation_of_duties": false, "severity": "normal", "version": 1} if {
	input.tool.egress_class in {"EXTERNAL", "PUBLIC"}
}

# internal-undoable-automatic v1
# Internal actions that can be undone completely run without waiting

matches contains {"approver_role": null, "citation": null, "decision": "ALLOW", "hold_window_ms": null, "id": "internal-undoable-automatic", "reason": null, "separation_of_duties": false, "severity": "low", "version": 1} if {
	input.tool.egress_class == "INTERNAL"
	input.tool.reversibility == "R1"
}

# reads-automatic v1
# Reading changes nothing

matches contains {"approver_role": null, "citation": null, "decision": "ALLOW", "hold_window_ms": null, "id": "reads-automatic", "reason": null, "separation_of_duties": false, "severity": "low", "version": 1} if {
	input.tool.reversibility == "R0"
}

# untrusted-recipient-block v1 — internal-sec-001
# A recipient derived from untrusted content is never permitted

matches contains {"approver_role": null, "citation": "internal-sec-001", "decision": "DENY", "hold_window_ms": null, "id": "untrusted-recipient-block", "reason": "Recipients must be people you named or entities your organization trusts", "separation_of_duties": false, "severity": "critical", "version": 1} if {
	input.tool.egress_class in {"EXTERNAL", "PUBLIC"}
	input.args.recipient.taint != null
	input.args.recipient.taint != "TRUSTED"
}
