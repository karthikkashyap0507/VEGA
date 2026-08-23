import { z } from 'zod';
import { Plan } from './enums.js';

/**
 * Tiers are DATA, not conditionals (PROJECT.md §22.1, decision D-09).
 *
 * Entitlements gate what is EXPOSED. They never gate business logic — there is no second
 * code path for a plan. `TIER-001` in scripts/verify-invariants.mjs enforces this.
 *
 * NOTE what is absent: `undo` and `taintDefense` are not entitlements and must never
 * become one (decision D-10). They ship identically on the free tier, because they are
 * the reason anyone chooses this over a free assistant.
 */
export const PlanLimits = z.object({
  runsPerMonth: z.number().int().nonnegative(),
  connectors: z.number().int().nonnegative(),
  seats: z.number().int().positive(),
  budgetCents: z.number().int().nonnegative(),
});
export type PlanLimits = z.infer<typeof PlanLimits>;

export const ExposedFeatures = z.object({
  policyAuthoring: z.boolean(),
  evidencePacks: z.boolean(),
  deterministicReplay: z.boolean(),
  approvalRouting: z.boolean(),
  dualApproval: z.boolean(),
  sharedWorkspaces: z.boolean(),
  knowledgeBase: z.boolean(),
  certificationLadder: z.boolean(),
  sso: z.boolean(),
  customerHeldKey: z.boolean(),
});
export type ExposedFeatures = z.infer<typeof ExposedFeatures>;

export const PlanEntitlement = z.object({
  plan: Plan,
  limits: PlanLimits,
  exposed: ExposedFeatures,
});
export type PlanEntitlement = z.infer<typeof PlanEntitlement>;

export type FeatureKey = keyof ExposedFeatures;
