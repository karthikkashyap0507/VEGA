# Rego unit tests for the professional-services pack (§5.2 regulatory citations), against the
# generated golden module.
package vega.packs.professional_services_test

import data.vega.packs.professional_services as pack

send := {
	"tool": {"id": "gmail.send", "egress_class": "EXTERNAL", "reversibility": "R2"},
	"target": {"audience": "CLIENT"},
	"data": {"sensitivity": 10, "labels": []},
	"effect": {"recipients": 1},
}

with_labels(ls) := object.union(send, {"data": {"labels": ls}})

ids(ms) := {m.id | some m in ms}

by_id(ms, id) := m if {
	some m in ms
	m.id == id
}

test_client_confidential_material_needs_approval_with_its_citation if {
	m := by_id(pack.matches, "client-confidentiality") with input as with_labels(["CONFIDENTIAL"])
	m.decision == "REQUIRE_APPROVAL"
	m.citation == "ABA Model Rule 1.6"
}

test_phi_never_leaves if {
	m := by_id(pack.matches, "health-data-never-external") with input as with_labels(["PHI"])
	m.decision == "DENY"
	m.reason != null
}

test_secrets_never_sent if {
	"credentials-never-sent" in ids(pack.matches) with input as with_labels(["SECRET"])
}

test_pii_to_non_clients_needs_approval_but_not_to_clients if {
	"personal-data-to-non-clients" in ids(pack.matches) with input as object.union(with_labels(["PII"]), {"target": {"audience": "EXTERNAL"}})
	got1 := ids(pack.matches) with input as with_labels(["PII"])
	not "personal-data-to-non-clients" in got1
}

test_large_value_is_dual_approval_with_separation_of_duties if {
	big := object.union(send, {"effect": {"monetary_value": {"amount": 10000, "currency": "EUR"}}})
	m := by_id(pack.matches, "large-value-dual-approval") with input as big
	m.decision == "REQUIRE_DUAL_APPROVAL"
	m.separation_of_duties == true
	small := object.union(send, {"effect": {"monetary_value": {"amount": 9999, "currency": "EUR"}}})
	got2 := ids(pack.matches) with input as small
	not "large-value-dual-approval" in got2
}

test_a_non_numeric_amount_never_matches_a_threshold if {
	odd := object.union(send, {"effect": {"monetary_value": {"amount": "10000", "currency": "EUR"}}})
	got3 := ids(pack.matches) with input as odd
	not "large-value-dual-approval" in got3
}

test_irreversible_needs_a_person if {
	r3 := object.union(send, {"tool": {"reversibility": "R3"}})
	"irreversible-human-oversight" in ids(pack.matches) with input as r3
}

test_internal_labelled_content_is_not_the_confidentiality_rule if {
	in_firm := object.union(with_labels(["CONFIDENTIAL"]), {"tool": {"egress_class": "INTERNAL"}})
	got4 := ids(pack.matches) with input as in_firm
	not "client-confidentiality" in got4
}
