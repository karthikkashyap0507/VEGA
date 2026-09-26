import type { Effect } from '@vega/contracts';

/**
 * How closely a simulated effect predicted the executed one — docs/module2.md §11.2.
 *
 * An effect is broken into FACETS, each either predicted correctly or not:
 *   externalRecipients   exact set equality (who the action reached is the risk signal)
 *   records              same number of records, same (system, field) pairs, and the same ids
 *                        wherever the simulation could know them (ids the provider assigns on
 *                        execution are null / '(new …)' in a simulation and are not compared)
 *   detail.<key>         every detail key the simulation filled in must match execution
 *   detail.shape         the same set of detail keys
 *   monetaryValue        equal when either side states one
 *
 * Score = facets matched / facets compared. The summary prose is never compared: a model reads
 * it, but policy and approvals run on the structured facets.
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

function canonical(v: unknown): string {
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
