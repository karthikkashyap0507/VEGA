import { buildBundle, type BuiltBundle, type SigningKey } from './bundle.js';
import { compileModule, packageFor } from './compile.js';
import { PRESET_MODES, PRESET_VERSION, presetPolicies } from './presets.js';
import type { Policy } from './schema.js';

/**
 * HOW BUNDLES REACH OPA (docs/module5.md §4, §8.2). Object storage holds signed bundles; OPA is
 * configured with ONE signed discovery bundle that names the bundles to load:
 *
 *   discovery.tar.gz                  → config: which bundles, from where, verified with which key
 *   presets/bundle.tar.gz             → vega.presets.{cautious,balanced,fast}  (ships with the platform)
 *   tenants/<tenant>/bundle.tar.gz    → vega.t_<tenant hex>                    (one per tenant, per activation)
 *
 * Every bundle — discovery included — is signed; OPA refuses one whose signature or file hashes
 * do not verify. The control plane writes; OPA (execution side) reads. Neither calls the other.
 */

export const PRESETS_BUNDLE = 'presets';
export const PRESETS_RESOURCE = 'presets/bundle.tar.gz';
export const DISCOVERY_RESOURCE = 'discovery.tar.gz';

/** The bundle name OPA reports in provenance, e.g. `t_0f3a…`. */
export function tenantBundleName(tenantId: string): string {
  return `t_${tenantId.replace(/-/g, '')}`;
}

export function tenantPackage(tenantId: string): string {
  return packageFor({ kind: 'tenant', tenantId });
}

/** Object key of a tenant's bundle: one stable key, rewritten on each activation (OPA polls it). */
export function tenantResource(tenantId: string): string {
  return `tenants/${tenantId}/bundle.tar.gz`;
}

/** Object key of one built version, kept for audit and rollback. */
export function tenantVersionResource(tenantId: string, version: number): string {
  return `tenants/${tenantId}/v${version}.tar.gz`;
}

export const revisionOf = (bundle: string, version: number) => `${bundle}@v${version}`;

/** `t_ab12@v7` → 7; anything else → null. */
export function versionOfRevision(revision: string | undefined | null): number | null {
  const m = /@v(\d+)$/.exec(revision ?? '');
  return m ? Number(m[1]) : null;
}

/** The presets bundle: all three modes, compiled from the YAML in presets.ts. */
export function buildPresetsBundle(key: SigningKey): BuiltBundle {
  return buildBundle(
    {
      roots: ['vega/presets'],
      revision: revisionOf(PRESETS_BUNDLE, PRESET_VERSION),
      modules: PRESET_MODES.map((m) => ({ path: `vega/presets/${m}/policy.rego`, content: compileModule(packageFor({ kind: 'preset', name: m }), presetPolicies(m)) })),
    },
    key,
  );
}

/** A tenant's bundle: every policy in its working set, one package, one module. */
export function buildTenantBundle(tenantId: string, version: number, policies: ReadonlyArray<{ policy: Policy; version: number }>, key: SigningKey): BuiltBundle & { rego: string } {
  const pkg = tenantPackage(tenantId);
  const rego = compileModule(pkg, policies);
  const root = pkg.replace(/\./g, '/');
  // An empty working set still ships a package: "no tenant policy matched" is an answer, and a
  // missing package for a tenant with an active bundle is an outage (the engine fails closed).
  const built = buildBundle({ roots: [root], revision: revisionOf(tenantBundleName(tenantId), version), modules: [{ path: `${root}/policy.rego`, content: rego }] }, key);
  return { ...built, rego };
}

export interface DiscoveryOptions {
  /** The OPA `services` entry bundles are fetched from (object storage). */
  service: string;
  keyId: string;
  tenants: ReadonlyArray<{ tenantId: string }>;
  polling?: { min: number; max: number };
  /** Bumped on every rebuild; OPA reports it in provenance as `discovery@v<n>`. */
  version: number;
}

/**
 * The discovery bundle: `data.discovery.config` is the OPA configuration fragment naming every
 * bundle. Tenants appear once they have an activated bundle.
 */
export function buildDiscoveryBundle(opts: DiscoveryOptions, key: SigningKey): BuiltBundle {
  const polling = { min_delay_seconds: opts.polling?.min ?? 5, max_delay_seconds: opts.polling?.max ?? 10 };
  const entry = (resource: string) => ({ service: opts.service, resource, persist: false, signing: { keyid: opts.keyId }, polling });
  const bundles: Record<string, unknown> = { [PRESETS_BUNDLE]: entry(PRESETS_RESOURCE) };
  for (const t of [...opts.tenants].sort((a, b) => a.tenantId.localeCompare(b.tenantId))) bundles[tenantBundleName(t.tenantId)] = entry(tenantResource(t.tenantId));
  return buildBundle(
    { roots: ['discovery'], revision: revisionOf('discovery', opts.version), modules: [], data: [{ path: 'discovery/data.json', content: JSON.stringify({ config: { bundles } }) }] },
    key,
  );
}
