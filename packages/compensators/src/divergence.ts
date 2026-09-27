import type { Effect } from '@vega/contracts';

/**
 * SIMULATED vs ACTUAL — docs/module6.md §5.7 (and the M2 simulation-accuracy harness, which
 * shares this comparison: evals/simulation).
 *
 * An effect is broken into FACETS, each predicted correctly or not:
 *   externalRecipients   exact set equality (who the action reached is the risk signal)
 *   records.shape        same number of records, same (system, field) pairs
 *   records.ids          the ids the simulation could know (ids the provider assigns on
 *                        execution are null / '(new …)' in a simulation and are not compared)
 *   detail.shape         the same set of detail keys
 *   detail.<key>         every detail key the simulation filled in
 *   monetaryValue        equal when either side states one
 *
 * The summary prose is never compared: a person reads it, but policy, approvals and the blast
 * radius run on the structured facets.
 */

export interface Facet {
  name: string;
  equal: boolean;
  simulated: unknown;
  executed: unknown;
}

export interface Comparison {
  facets: Facet[];
  matched: number;
  compared: number;
  score: number;
}

export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sortedSet = (xs: string[]) => [...new Set(xs.map((x) => x.toLowerCase()))].sort();

/**
 * Values a simulation legitimately cannot know: assigned by the provider at execution time.
 * Convention for every connector: such ids are written `(new <thing>)`, optionally after a
 * known prefix (`C002:(new message)`), and nulls in `detail`.
 */
function unknowable(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.includes('(new '));
}

export function compareEffects(sim: Effect<unknown>, exe: Effect<unknown>): Comparison {
  const facets: Facet[] = [];
  const push = (name: string, simulated: unknown, executed: unknown, equal: boolean) => facets.push({ name, simulated, executed, equal });

  push('externalRecipients', sortedSet(sim.externalRecipients), sortedSet(exe.externalRecipients), same(sortedSet(sim.externalRecipients), sortedSet(exe.externalRecipients)));

  const shape = (e: Effect<unknown>) => e.recordsAffected.map((r) => `${r.system}|${r.field ?? ''}`).sort();
  push('records.shape', shape(sim), shape(exe), same(shape(sim), shape(exe)));
  const simIds = sim.recordsAffected.map((r) => r.id).filter((id) => !unknowable(id)).sort();
  const exeIds = exe.recordsAffected.map((r) => r.id).sort();
  if (simIds.length) push('records.ids', simIds, exeIds, simIds.every((id) => exeIds.includes(id)));

  const sd = (sim.detail ?? {}) as Record<string, unknown>;
  const ed = (exe.detail ?? {}) as Record<string, unknown>;
  push('detail.shape', Object.keys(sd).sort(), Object.keys(ed).sort(), same(Object.keys(sd).sort(), Object.keys(ed).sort()));
  for (const key of Object.keys(sd)) {
    if (unknowable(sd[key])) continue;
    // Arrays of content (search results, file bodies) are READ outputs, not predictions.
    if (Array.isArray(sd[key]) && (sd[key] as unknown[]).length === 0) continue;
    push(`detail.${key}`, sd[key], ed[key], same(sd[key], ed[key]));
  }

  if (sim.monetaryValue || exe.monetaryValue) push('monetaryValue', sim.monetaryValue, exe.monetaryValue, same(sim.monetaryValue, exe.monetaryValue));

  const matched = facets.filter((f) => f.equal).length;
  return { facets, matched, compared: facets.length, score: facets.length ? matched / facets.length : 1 };
}

/**
 * Per-tool tolerance (§5.7: "an event id will differ; a recipient list must not"). Everything
 * is strict unless a tool names a detail key that may legitimately move between the simulation
 * and the call — a conflict count that changed because someone else booked a slot in between.
 * Who is reached, which records change, and money are never tolerated.
 */
const LENIENT: Record<string, readonly string[]> = {
  'gcal.create': ['detail.conflicts'],
  'gcal.update': ['detail.conflicts'],
  'gcal.delete': ['detail.conflicts'],
};

export type DivergenceSeverity = 'NONE' | 'WITHIN_TOLERANCE' | 'ABORT';

export interface Divergence {
  severity: DivergenceSeverity;
  /** The facets that differed, strict first. */
  diff: Array<Facet & { tolerated: boolean }>;
  comparison: Comparison;
}

export function divergence(toolId: string, simulated: Effect<unknown>, actual: Effect<unknown>): Divergence {
  const comparison = compareEffects(simulated, actual);
  const lenient = new Set(LENIENT[toolId] ?? []);
  const diff = comparison.facets
    .filter((f) => !f.equal)
    .map((f) => ({ ...f, tolerated: lenient.has(f.name) }))
    .sort((a, b) => Number(a.tolerated) - Number(b.tolerated));
  const severity: DivergenceSeverity = diff.length === 0 ? 'NONE' : diff.some((f) => !f.tolerated) ? 'ABORT' : 'WITHIN_TOLERANCE';
  return { severity, diff, comparison };
}

/** One sentence for the run and the incident: what did not match. */
export function divergenceText(toolId: string, d: Divergence): string {
  const strict = d.diff.filter((f) => !f.tolerated).map((f) => f.name);
  if (!strict.length) return `${toolId} behaved as simulated`;
  return `${toolId} did not do what its simulation said (${strict.join(', ')} differed)`;
}
