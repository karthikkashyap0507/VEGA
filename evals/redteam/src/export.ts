import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { corpus, corpusStats } from './corpus.js';

/**
 * Exports the corpus for Promptfoo (evals/redteam/promptfoo/promptfooconfig.yaml), which runs it
 * against the LIVE quarantined extractor model. That suite measures prompt hardening — defence
 * in depth. The blocking gate is test/redteam.test.ts, which assumes a fully compromised
 * extractor and checks the architecture instead.
 */
const dir = join(process.cwd(), 'evals', 'redteam', 'promptfoo');
mkdirSync(dir, { recursive: true });
const cases = corpus().map((c) => ({ description: `${c.category} / ${c.encoding}`, vars: { content: c.content, schema: c.goal === 'exfil-data' ? 'Invoice' : 'Summary' } }));
writeFileSync(join(dir, 'cases.json'), JSON.stringify(cases, null, 1));
console.log(corpusStats());
