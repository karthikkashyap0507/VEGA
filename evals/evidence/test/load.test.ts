import { describe, expect, it } from 'vitest';
import { runLoad } from '../src/index.js';

/**
 * The load eval at CI size (docs/module7.md §11 "pack build performance"). The full run —
 * 100,000 entries over 12 months, `pnpm --filter @vega/eval-evidence eval` — is recorded in
 * report/report.md; this keeps the path exercised and the budget honest on every build.
 */
describe('evidence pack build performance', () => {
  it('a 12-month single-client pack builds well inside budget and verifies offline', async () => {
    const r = await runLoad({
      ownerUrl: process.env['EVIDENCE_DATABASE_URL'] ?? 'postgresql://vega_evi:vega_evi_local_dev_only@localhost:5433/vega_evidence',
      writerUrl: process.env['EVIDENCE_WRITER_URL'] ?? 'postgresql://vega_evi_writer:vega_evi_writer_local@localhost:5433/vega_evidence',
      readerUrl: process.env['EVIDENCE_READER_URL'] ?? 'postgresql://vega_evi_reader:vega_evi_reader_local@localhost:5433/vega_evidence',
      entries: 6_000,
      clientShare: 0.25,
      appendSamples: 100,
    });
    expect(r.pack.failures).toEqual([]);
    expect(r.pack.verified).toBe(true);
    expect(r.pack.entries).toBe(r.clientEntries);
    // Linear in the entries: 6k must leave the 60 s budget for the full size untouched.
    expect(r.pack.buildMs).toBeLessThan(10_000);
    expect(r.append.p99Ms).toBeLessThan(250);
  }, 240_000);
});
