/**
 * NOVELTY DETECTION — docs/module10.md §6.1. "Feature statistics + distance; not an opaque
 * model" (§17) — a risk committee can read exactly why an input scored as novel, the same
 * transparency rule M5's risk function already holds to.
 *
 * At certification, capture the input distribution for the certified sample (recipient domain,
 * content length, hour of day, value/amount, entity types touched). At runtime, score each new
 * input against that baseline: numeric features by z-score, categorical features by whether the
 * value was ever seen. A materially out-of-distribution input routes THAT ACTION to a human —
 * the workflow's tier is untouched; only this one call is not autonomous.
 */

export interface Features {
  domain?: string;
  contentLength?: number;
  hourOfDay?: number;
  valueCents?: number;
  entityTypes?: string[];
}

interface NumericStat {
  n: number;
  mean: number;
  variance: number;
}

export interface FeatureStats {
  domains: Record<string, number>;
  entityTypes: Record<string, number>;
  contentLength: NumericStat | null;
  hourOfDay: NumericStat | null;
  valueCents: NumericStat | null;
}

function fit(values: number[]): NumericStat | null {
  if (!values.length) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return { n: values.length, mean, variance };
}

/** Captured once, at certification time, from the certified sample's own inputs. */
export function capture(samples: Features[]): FeatureStats {
  const count = (xs: Array<string | undefined>) => {
    const out: Record<string, number> = {};
    for (const x of xs) if (x) out[x] = (out[x] ?? 0) + 1;
    return out;
  };
  const domains = count(samples.map((s) => s.domain));
  const entityTypes: Record<string, number> = {};
  for (const s of samples) for (const t of s.entityTypes ?? []) entityTypes[t] = (entityTypes[t] ?? 0) + 1;
  return {
    domains,
    entityTypes,
    contentLength: fit(samples.map((s) => s.contentLength).filter((x): x is number => x !== undefined)),
    hourOfDay: fit(samples.map((s) => s.hourOfDay).filter((x): x is number => x !== undefined)),
    valueCents: fit(samples.map((s) => s.valueCents).filter((x): x is number => x !== undefined)),
  };
}

export interface NoveltyScore {
  novel: boolean;
  /** One line per feature that pushed the score — what a person reads to see why. */
  reasons: string[];
  maxZ: number;
}

const Z_THRESHOLD = 3; // ~99.7th percentile under normality; transparent, tunable, never opaque
const MIN_SAMPLES_FOR_Z = 20; // too few certified samples to trust a variance estimate

function zscore(x: number, stat: NumericStat | null): number {
  if (!stat || stat.n < MIN_SAMPLES_FOR_Z) return 0;
  const sd = Math.sqrt(stat.variance);
  if (sd < 1e-9) return x === stat.mean ? 0 : Infinity;
  return Math.abs(x - stat.mean) / sd;
}

/** Score one new input against the baseline. Never seeing a domain/entity type before counts too. */
export function score(input: Features, baseline: FeatureStats): NoveltyScore {
  const reasons: string[] = [];
  let maxZ = 0;

  if (input.domain && baseline.domains[input.domain] === undefined && Object.keys(baseline.domains).length > 0) {
    reasons.push(`recipient domain "${input.domain}" was never seen in the certified sample`);
    maxZ = Math.max(maxZ, Z_THRESHOLD);
  }
  for (const t of input.entityTypes ?? []) {
    if (baseline.entityTypes[t] === undefined && Object.keys(baseline.entityTypes).length > 0) {
      reasons.push(`entity type "${t}" was never seen in the certified sample`);
      maxZ = Math.max(maxZ, Z_THRESHOLD);
    }
  }
  if (input.contentLength !== undefined) {
    const z = zscore(input.contentLength, baseline.contentLength);
    if (z >= Z_THRESHOLD) reasons.push(`content length ${input.contentLength} is ${z.toFixed(1)}σ from the certified sample`);
    maxZ = Math.max(maxZ, z);
  }
  if (input.hourOfDay !== undefined) {
    const z = zscore(input.hourOfDay, baseline.hourOfDay);
    if (z >= Z_THRESHOLD) reasons.push(`hour of day ${input.hourOfDay} is ${z.toFixed(1)}σ from the certified sample`);
    maxZ = Math.max(maxZ, z);
  }
  if (input.valueCents !== undefined) {
    const z = zscore(input.valueCents, baseline.valueCents);
    if (z >= Z_THRESHOLD) reasons.push(`value ${(input.valueCents / 100).toFixed(2)} is ${z.toFixed(1)}σ from the certified sample`);
    maxZ = Math.max(maxZ, z);
  }
  return { novel: reasons.length > 0, reasons, maxZ: Number.isFinite(maxZ) ? maxZ : 999 };
}

/** What the executor can read off an effect/args without any workflow-specific knowledge. */
export function featuresOf(i: { recipients?: string[]; textLength?: number; at?: Date; entityTypes?: string[]; valueCents?: number }): Features {
  const domain = i.recipients?.[0]?.split('@')[1]?.toLowerCase();
  return { ...(domain ? { domain } : {}), ...(i.textLength !== undefined ? { contentLength: i.textLength } : {}), hourOfDay: (i.at ?? new Date()).getUTCHours(), ...(i.entityTypes ? { entityTypes: i.entityTypes } : {}), ...(i.valueCents !== undefined ? { valueCents: i.valueCents } : {}) };
}
