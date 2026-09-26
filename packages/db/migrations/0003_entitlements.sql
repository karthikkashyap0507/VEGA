-- =============================================================================
-- 0003_entitlements — the five plans as DATA (PROJECT.md §22.2, decision D-09)
--
-- Initial values only. Changing a plan afterwards is an UPDATE to this table, not a code
-- change and not a release: that is the whole point of entitlements-as-data.
--
-- `exposed` gates which SURFACES a plan reaches. There is no `undo` or `taint_defense` key,
-- and there must never be one (D-10): both ship identically on the free tier.
-- ON CONFLICT DO NOTHING so an operator's later edits survive a re-run on a fresh replica.
-- =============================================================================

INSERT INTO plan_entitlements (plan, limits, exposed) VALUES
  ('free',
   '{"runsPerMonth": 50, "connectors": 1, "seats": 1, "budgetCents": 0}',
   '{"policyAuthoring": false, "evidencePacks": false, "deterministicReplay": false,
     "approvalRouting": false, "dualApproval": false, "sharedWorkspaces": false,
     "knowledgeBase": false, "certificationLadder": false, "sso": false, "customerHeldKey": false}'),
  ('pro',
   '{"runsPerMonth": 1000, "connectors": 5, "seats": 1, "budgetCents": 5000}',
   '{"policyAuthoring": false, "evidencePacks": false, "deterministicReplay": false,
     "approvalRouting": false, "dualApproval": false, "sharedWorkspaces": false,
     "knowledgeBase": true, "certificationLadder": false, "sso": false, "customerHeldKey": false}'),
  ('business',
   '{"runsPerMonth": 10000, "connectors": 20, "seats": 50, "budgetCents": 50000}',
   '{"policyAuthoring": false, "evidencePacks": false, "deterministicReplay": false,
     "approvalRouting": false, "dualApproval": false, "sharedWorkspaces": true,
     "knowledgeBase": true, "certificationLadder": false, "sso": false, "customerHeldKey": false}'),
  ('teams',
   '{"runsPerMonth": 100000, "connectors": 50, "seats": 250, "budgetCents": 250000}',
   '{"policyAuthoring": true, "evidencePacks": false, "deterministicReplay": false,
     "approvalRouting": true, "dualApproval": true, "sharedWorkspaces": true,
     "knowledgeBase": true, "certificationLadder": true, "sso": false, "customerHeldKey": false}'),
  ('enterprise',
   '{"runsPerMonth": 1000000, "connectors": 500, "seats": 10000, "budgetCents": 1000000}',
   '{"policyAuthoring": true, "evidencePacks": true, "deterministicReplay": true,
     "approvalRouting": true, "dualApproval": true, "sharedWorkspaces": true,
     "knowledgeBase": true, "certificationLadder": true, "sso": true, "customerHeldKey": true}')
ON CONFLICT (plan) DO NOTHING;
