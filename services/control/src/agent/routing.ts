import { and, eq, gte, sql } from 'drizzle-orm';
import { schema, withTenant } from '@vega/db';
import { routeModel, RoutingRefused, type ModelChoice, type Plan, type RouterCatalog } from '@vega/policy-engine';

/**
 * C4 — the model router applied to planning (docs/module5.md §5.6, decision D-12). Which model
 * plans a run is policy: the tenant's plan picks the class (self-serve plans plan with the
 * economy model below Teams), a residency setting pins the region, and a spent budget refuses — it never
 * bills a surprise and never silently upgrades. LiteLLM (when configured) owns providers, keys
 * and spend; this chooses only the model name it is asked for.
 *
 * Module 10 §12 / P5: what happens at the cap is configurable per tenant (the `budgets` row):
 *   queue    the plan is refused until the budget is raised or the period turns (the default)
 *   degrade  keep planning, but with the economy model — a DOWNGRADE, never an upgrade
 *   halt     refuse new plans AND stop in-flight runs at their next consequential step (the
 *            executor reads the same row)
 * Every breach is a `budget.exceeded` event; none of them ever bills a surprise.
 */

export interface PlannerRoute {
  (run: { tenantId: string }): Promise<ModelChoice>;
}

const PLANS: ReadonlySet<string> = new Set(['free', 'pro', 'business', 'teams', 'enterprise']);

/** Maps a tenant's hosting region (`eu-west-1`) to the catalog's residency zone (`eu`). */
export function residencyZone(region: string | null | undefined): string | null {
  if (!region) return null;
  const zone = region.split('-')[0]!.toLowerCase();
  return zone === 'eu' || zone === 'us' ? zone : null;
}

export function plannerRoute(catalog: RouterCatalog): PlannerRoute {
  return async ({ tenantId }) =>
    withTenant(tenantId, async (db) => {
      const [t] = await db.select({ plan: schema.tenants.plan, region: schema.tenants.region, settings: schema.tenants.settings }).from(schema.tenants).where(eq(schema.tenants.id, tenantId));
      const settings = (t?.settings ?? {}) as { residencyPinned?: boolean; budgetCents?: number };
      const [ent] = t ? await db.select({ limits: schema.planEntitlements.limits }).from(schema.planEntitlements).where(eq(schema.planEntitlements.plan, t.plan)) : [];
      const [spend] = await db
        .select({ c: sql<string>`coalesce(sum(${schema.runs.costCents}), 0)` })
        .from(schema.runs)
        .where(gte(schema.runs.startedAt, sql`date_trunc('month', now())`));
      const [cap] = await db.select().from(schema.budgets).where(eq(schema.budgets.tenantId, tenantId));
      const limit = cap && cap.limitCents > 0 ? cap.limitCents : (settings.budgetCents ?? (ent?.limits as { budgetCents?: number } | undefined)?.budgetCents ?? 0);
      const breach = (cap?.breachBehavior ?? 'queue') as 'degrade' | 'queue' | 'halt';
      const spent = Number(spend?.c ?? 0);
      const plan = (t && PLANS.has(t.plan) ? t.plan : 'teams') as Plan;
      const choice = routeModel(
        {
          purpose: 'planner',
          plan,
          // The planner never sees content (M3 §7.5): its prompt carries no untrusted data by construction.
          untrusted: false,
          residency: settings.residencyPinned ? residencyZone(t?.region) : null,
          budget: { spentCents: spent, limitCents: limit },
        },
        catalog,
      );
      if (!choice.queue) return choice;
      // The cap is reached. Tell the tenant (once an hour at most), then apply what they chose.
      const recent = await db.select({ id: schema.platformEvents.id }).from(schema.platformEvents).where(and(eq(schema.platformEvents.kind, 'budget.exceeded'), gte(schema.platformEvents.createdAt, sql`now() - interval '1 hour'`))).limit(1);
      if (!recent.length) await db.insert(schema.platformEvents).values({ tenantId, actorId: null, kind: 'budget.exceeded', payload: { spentCents: spent, limitCents: limit, behavior: breach } });
      if (breach === 'degrade' && choice.model !== catalog.economy.planner) {
        return { ...choice, model: catalog.economy.planner, queue: false, reasons: [...choice.reasons, `budget reached → degraded to the economy model (${catalog.economy.planner}); never a surprise bill, never a silent upgrade`] };
      }
      return { ...choice, reasons: [...choice.reasons, breach === 'halt' ? 'budget reached → halted: new plans refused and in-flight runs stop at their next consequential step' : 'budget reached → queued'] };
    });
}

export { RoutingRefused };
