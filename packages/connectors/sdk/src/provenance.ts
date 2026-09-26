import { createHash } from 'node:crypto';
import type { Sourced, TaintLevel } from '@vega/contracts';

/**
 * Provenance at the source (module2.md §16): every value a connector reads is returned already
 * wrapped, so Module 3 propagates labels rather than inventing them.
 *
 * `sourceId` is `<connector>:<kind>:<provider id>#<sha256 prefix>` — stable for the same
 * content, different when the content changes, and resolvable to a content-addressed blob
 * once Module 7 stores inputs by digest.
 */
export function sourced<T>(value: T, input: { system: string; id: string; taint: TaintLevel }): Sourced<T> {
  const digest = createHash('sha256').update(JSON.stringify(value) ?? '').digest('hex').slice(0, 16);
  return { value, sourceId: `${input.system}:${input.id}#${digest}`, taint: input.taint };
}

/** Recipients outside the tenant's domains. External recipients raise risk (M5) and feed M10. */
export function externalOnly(addresses: string[], internalDomains: string[]): string[] {
  const internal = new Set(internalDomains.map((d) => d.toLowerCase()));
  return addresses.filter((a) => {
    const domain = a.split('@')[1]?.toLowerCase();
    return !domain || !internal.has(domain);
  });
}
