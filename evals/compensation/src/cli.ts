import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdown, runHarness } from './index.js';

/** `pnpm --filter @vega/eval-compensation eval` — writes evals/compensation/report; exit 1 below threshold. */
if (process.env['CONNECTOR_SANDBOX'] === 'live') {
  console.error('CONNECTOR_SANDBOX=live needs the provider test tenants of docs/module2.md §11.1; not configured in this environment.');
  process.exit(2);
}
const report = await runHarness();
const dir = join(process.cwd(), 'evals', 'compensation', 'report');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(dir, 'report.md'), markdown(report));
console.log(markdown(report));
process.exit(report.ok ? 0 : 1);
