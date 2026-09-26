import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { declarationsSql, launchRegistry } from '@vega/connectors';

/** Writes packages/db/reference/tool_declarations.sql from the connector registry. */
const out = join(import.meta.dirname, '..', 'packages', 'db', 'reference', 'tool_declarations.sql');
writeFileSync(out, declarationsSql(launchRegistry()));
console.log(`wrote ${out}`);
