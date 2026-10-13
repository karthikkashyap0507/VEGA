import { moreRestrictive, type Tier } from './ladder.js';
import type { AutonomyStore, TransitionRow } from './store.js';

/**
 * AUTOMATIC DEMOTION — docs/module10.md §6. "Immediate and automatic," and §18 "cannot be
 * suppressed: automatic demotion has no override path; only re-certification restores." There
 * is deliberately no `promote-back` function here — the only way up is `certification.ts`.
 *
 * Novelty (§6.1) is NOT a trigger this engine handles: a novel input routes THAT CALL to a
 * human without touching the workflow's tier (packages/autonomy's ladder floor does that per
 * call). Everything here demotes the (workflow × action) pair itself.
 */
export type DemotionTrigger = 'critical_error' | 'error_rate' | 'comp_failure' | 'taint_violation' | 'version_change' | 'volume_spike';

/** How far each trigger falls. Harm or near-harm goes straight to SUSPENDED; a broken
 *  certification guarantee (versions, volume) falls back to a human, not all the way out. */
const TARGET: Record<DemotionTrigger, Tier> = {
  critical_error: 'SUSPENDED',
  comp_failure: 'SUSPENDED',
  taint_violation: 'SUSPENDED',
  error_rate: 'SUPERVISED',
  version_change: 'SUPERVISED',
  volume_spike: 'SUPERVISED',
};


export interface DemotionResult {
  demoted: boolean;
  from: Tier;
  to: Tier;
  transition?: TransitionRow;
}

export class DemotionEngine {
  constructor(private readonly store: AutonomyStore) {}

  async demote(tenantId: string, workflowKey: string, actionType: string, trigger: DemotionTrigger, evidence: Record<string, unknown>): Promise<DemotionResult> {
    const current = await this.store.get(tenantId, workflowKey, actionType);
    // A pair that was never put on the ladder has no tier to fall from: it stays untiered (§1
    // "blocks nothing"). The signal itself is already on record (taint_violations, incidents, the
    // override corpus); this engine only moves pairs that have a tier.
    if (!current) return { demoted: false, from: 'AUTONOMOUS', to: 'AUTONOMOUS' };
    const from = current.tier as Tier;
    const to = TARGET[trigger];
    if (!moreRestrictive(from, to)) return { demoted: false, from, to: from };
    const { transition } = await this.store.transition({ tenantId, workflowKey, actionType, fromTier: from, toTier: to, direction: 'DEMOTE', trigger, evidence });
    return { demoted: true, from, to, transition };
  }
}
