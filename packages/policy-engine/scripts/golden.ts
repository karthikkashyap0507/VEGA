import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileModule, parsePolicyYaml, PRESET_MODES, presetPolicies, PROFESSIONAL_SERVICES_PACK } from '../src/index.js';

/** Regenerates the compiler's golden files. Review the diff: it IS the policy change. */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'golden');
export function goldens(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const mode of PRESET_MODES) out[`preset-${mode}.rego`] = compileModule(`vega.presets.${mode}`, presetPolicies(mode));
  out['pack-professional-services.rego'] = compileModule('vega.packs.professional_services', parsePolicyYaml(PROFESSIONAL_SERVICES_PACK).map((policy) => ({ policy, version: 1 })));
  return out;
}
if (process.argv[1] && process.argv[1].endsWith('golden.ts')) {
  for (const [name, rego] of Object.entries(goldens())) writeFileSync(join(dir, name), rego);
  console.log('golden files written');
}
