import { createLogger } from '@vega/shared';
import { EvidenceWriter, migrateEvidence } from '@vega/db/evidence';
import { buildEvidenceApp } from './app.js';

const logger = createLogger('evidence');
const ownerUrl = process.env['EVIDENCE_DATABASE_URL'];
const writerUrl = process.env['EVIDENCE_WRITER_URL'];
const appendToken = process.env['EVIDENCE_APPEND_TOKEN'];
if (!ownerUrl || !writerUrl || !appendToken) {
  throw new Error('EVIDENCE_DATABASE_URL, EVIDENCE_WRITER_URL and EVIDENCE_APPEND_TOKEN are required');
}

await migrateEvidence(ownerUrl);
const writer = new EvidenceWriter(writerUrl);
const app = await buildEvidenceApp({ writer, appendToken, logger });
const port = Number(process.env['EVIDENCE_PORT'] ?? 3004);
await app.listen({ port, host: process.env['HOST'] ?? '127.0.0.1' });
logger.info({ port }, 'evidence plane listening (append-only)');
