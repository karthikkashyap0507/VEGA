# GENERATED from YAML policies by @vega/policy-engine — never edit by hand.

package vega.presets.cautious

import rego.v1

# budget-exhausted v1
# Over the monthly budget nothing more runs — it queues, it never bills a surprise

matches contains {"approver_role": null, "citation": null, "decision": "DENY", "hold_window_ms": null, "id": "budget-exhausted", "reason": "The monthly budget is spent; raise it or wait for the next period", "separation_of_duties": false, "severity": "high", "version": 1} if {
	input.budget.exhausted == true
}

# external-approval v1
# Everything that leaves the organization needs approval, then a hold

matches contains {"approver_role": "APPROVER", "citation": null, "decision": "REQUIRE_APPROVAL", "hold_window_ms": 300000, "id": "external-approval", "reason": null, "separation_of_duties": false, "severity": "high", "version": 1} if {
	input.tool.egress_class in {"EXTERNAL", "PUBLIC"}
}

# internal-final-approval v1
# Internal changes that cannot be fully undone need approval

matches contains {"approver_role": "APPROVER", "citation": null, "decision": "REQUIRE_APPROVAL", "hold_window_ms": null, "id": "internal-final-approval", "reason": null, "separation_of_duties": false, "severity": "high", "version": 1} if {
	input.tool.egress_class == "INTERNAL"
	input.tool.reversibility in {"R2", "R3"}
}

# internal-undoable-hold v1
# Internal changes wait a minute before they happen

matches contains {"approver_role": null, "citation": null, "decision": "ALLOW_WITH_HOLD", "hold_window_ms": 60000, "id": "internal-undoable-hold", "reason": null, "separation_of_duties": false, "severity": "normal", "version": 1} if {
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
