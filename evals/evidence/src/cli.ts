import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markdown, runLoad } from './index.js';

/**
 * pnpm --filter @vega/eval-evidence eval [entries] [clientShare]
 * Defaults: 100,000 entries over 12 months, 25% of runs about the one client.
 */
const entries = Number(process.argv[2] ?? 100_000);
const clientShare = Number(process.argv[3] ?? 0.25);
const env = process.env;
const report = await runLoad({
  ownerUrl: env['EVIDENCE_DATABASE_URL'] ?? 'postgresql://vega_evi:vega_evi_local_dev_only@localhost:5433/vega_evidence',
  writerUrl: env['EVIDENCE_WRITER_URL'] ?? 'postgresql://vega_evi_writer:vega_evi_writer_local@localhost:5433/vega_evidence',
  readerUrl: env['EVIDENCE_READER_URL'] ?? 'postgresql://vega_evi_reader:vega_evi_reader_local@localhost:5433/vega_evidence',
  entries,
  clientShare,
  log: (m) => console.log(m),
});
const dir = join('evals', 'evidence', 'report');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(dir, 'report.md'), markdown(report));
console.log(`\n${markdown(report)}`);
process.exit(report.passed ? 0 : 1);
