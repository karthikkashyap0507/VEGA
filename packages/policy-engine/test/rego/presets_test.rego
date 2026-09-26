# Rego unit tests over the GENERATED preset modules (docs/module5.md §11 "Rego unit tests").
# The TS differential suite proves compiled Rego ≡ the reference evaluator on random inputs;
# these pin the §5.7 table itself, in OPA's own test framework, against the golden output.
package vega.presets_test

import data.vega.presets.balanced
import data.vega.presets.cautious
import data.vega.presets.fast

base := {
	"tool": {"id": "gmail.send", "egress_class": "EXTERNAL", "reversibility": "R2"},
	"args": {"taint": "TRUSTED", "recipient": {"taint": "TRUSTED", "count": 1}},
	"target": {"audience": "CLIENT"},
	"data": {"sensitivity": 10, "labels": []},
	"budget": {"exhausted": false},
}

internal_draft := object.union(base, {"tool": {"id": "gmail.draft", "egress_class": "INTERNAL", "reversibility": "R1"}})

untrusted := object.union(base, {"args": {"taint": "UNTRUSTED", "recipient": {"taint": "UNTRUSTED", "count": 1}}})

ids(ms) := {m.id | some m in ms}

decisions(ms) := {m.decision | some m in ms}

test_untrusted_recipient_is_denied_in_every_mode if {
	"untrusted-recipient-block" in ids(balanced.matches) with input as untrusted
	"untrusted-recipient-block" in ids(cautious.matches) with input as untrusted
	"untrusted-recipient-block" in ids(fast.matches) with input as untrusted
}

test_a_recipient_without_taint_is_not_the_untrusted_rule if {
	no_taint := object.union(base, {"args": {"recipient": {"count": 1}}})
	got1 := ids(balanced.matches) with input as no_taint
	not "untrusted-recipient-block" in got1
}

test_budget_exhausted_denies if {
	over := object.union(base, {"budget": {"exhausted": true}})
	"DENY" in decisions(balanced.matches) with input as over
	"DENY" in decisions(fast.matches) with input as over
}

test_external_send_modes_differ_per_the_table if {
	holds := [m | some m in balanced.matches with input as base; m.decision == "ALLOW_WITH_HOLD"]
	holds[0].hold_window_ms == 120000
	fast_holds := [m | some m in fast.matches with input as base; m.decision == "ALLOW_WITH_HOLD"]
	fast_holds[0].hold_window_ms == 30000
	"REQUIRE_APPROVAL" in decisions(cautious.matches) with input as base
}

test_internal_undoable_runs_in_balanced_and_waits_in_cautious if {
	decisions(balanced.matches) == {"ALLOW"} with input as internal_draft
	"ALLOW_WITH_HOLD" in decisions(cautious.matches) with input as internal_draft
}

test_reads_are_automatic if {
	read := object.union(base, {"tool": {"id": "gmail.search", "egress_class": "INTERNAL", "reversibility": "R0"}})
	"reads-automatic" in ids(balanced.matches) with input as read
	decisions(cautious.matches) == {"ALLOW"} with input as read
}

test_nothing_matching_is_the_empty_set_not_undefined if {
	count(balanced.matches) == 0 with input as {}
}
