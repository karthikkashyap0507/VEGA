/**
 * C4 — THE MODEL ROUTER (docs/module5.md §5.6; assigned here by PROJECT.md D-12). Routing rules
 * are policy: which model may see which data, at which accuracy floor, in which region. A thin
 * rule layer over LiteLLM, which owns providers, keys, spend and caching — we do not build a
 * gateway. Never marketed; existential below Teams.
 *
 * Hard rules, in order, each overriding cost optimisation:
 *   1. anything carrying UNTRUSTED content → the quarantined extraction model only (M3 §7.5)
 *   2. HIGH/CRITICAL risk → the highest-accuracy model for the purpose, whatever it costs
 *   3. residency-constrained tenants → approved regions/providers only
 *   4. plans below Teams (free, pro, business) → Sonnet/Haiku-class planning
 *   and a budget breach degrades or queues — it never bills a surprise, never silently upgrades.
 */

export type Purpose = 'planner' | 'intent' | 'extractor';
/** The plans of `plan_entitlements` (module1.md, migration 0003). */
export type Plan = 'free' | 'pro' | 'business' | 'teams' | 'enterprise';

export interface ModelChoice {
  model: string;
  /** Where the request may be served (LiteLLM routes within it). */
  region: string | null;
  reasons: string[];
  /** Over budget: the caller queues the work instead of running it. */
  queue?: boolean;
}

export interface RouterCatalog {
  best: Record<Purpose, string>;
  economy: Record<Purpose, string>;
  quarantined: string;
  /** Regions each model is approved in (residency). */
  regions: Record<string, string[]>;
}

export const DEFAULT_CATALOG: RouterCatalog = {
  best: { planner: 'claude-opus-5', intent: 'claude-sonnet-5', extractor: 'claude-haiku-4-5-20251001' },
  economy: { planner: 'claude-sonnet-5', intent: 'claude-haiku-4-5-20251001', extractor: 'claude-haiku-4-5-20251001' },
  quarantined: 'claude-haiku-4-5-20251001',
  regions: { 'claude-opus-5': ['us', 'eu'], 'claude-sonnet-5': ['us', 'eu'], 'claude-haiku-4-5-20251001': ['us', 'eu'] },
};

export interface RouteInput {
  purpose: Purpose;
  plan: Plan;
  /** The prompt (or any part of it) carries UNTRUSTED content. */
  untrusted: boolean;
  riskTier?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | undefined;
  /** Tenant residency constraint (module1 tenant `region`), e.g. "eu". */
  residency?: string | null | undefined;
  budget?: { spentCents: number; limitCents: number } | undefined;
}

export class RoutingRefused extends Error {}

/** "Existential below Teams" (§5.6): every plan below Teams plans with the economy class. */
const SELF_SERVE: ReadonlySet<Plan> = new Set(['free', 'pro', 'business']);

export function routeModel(input: RouteInput, catalog: RouterCatalog = DEFAULT_CATALOG): ModelChoice {
  const reasons: string[] = [];
  if (input.untrusted && input.purpose !== 'extractor') {
    // The planner and the intent model never see content (M3 §7.5): refusing is the only answer.
    throw new RoutingRefused(`a ${input.purpose} prompt must not carry untrusted content`);
  }
  let model: string;
  if (input.untrusted) {
    model = catalog.quarantined;
    reasons.push('untrusted content → the quarantined extraction model only');
  } else if (input.riskTier === 'HIGH' || input.riskTier === 'CRITICAL') {
    model = catalog.best[input.purpose];
    reasons.push(`${input.riskTier} risk → the highest-accuracy model, regardless of cost`);
  } else if (SELF_SERVE.has(input.plan)) {
    model = catalog.economy[input.purpose];
    reasons.push(`${input.plan} plan → economy model (margin, PROJECT.md §22.6)`);
  } else {
    model = catalog.best[input.purpose];
    reasons.push(`${input.plan} plan → the default model for ${input.purpose}`);
  }
  let region: string | null = null;
  if (input.residency) {
    const ok = catalog.regions[model] ?? [];
    if (!ok.includes(input.residency)) throw new RoutingRefused(`${model} is not approved in ${input.residency}`);
    region = input.residency;
    reasons.push(`residency → served in ${input.residency} only`);
  }
  const b = input.budget;
  if (b && b.limitCents > 0 && b.spentCents >= b.limitCents) {
    reasons.push('budget reached → queued, not run (never a surprise bill, never a silent upgrade)');
    return { model, region, reasons, queue: true };
  }
  return { model, region, reasons };
}
