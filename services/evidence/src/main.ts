import { createLogger, internalServerTls, loadTls, startHealthServer } from '@vega/shared';
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
const tls = loadTls();
if (!tls) logger.warn('DEV: plain HTTP; in a cluster evidence accepts only mTLS clients');
const app = await buildEvidenceApp({ writer, appendToken, logger, ...(tls ? { https: internalServerTls(tls) } : {}) });
const port = Number(process.env['EVIDENCE_PORT'] ?? 3004);
await app.listen({ port, host: process.env['HOST'] ?? '127.0.0.1' });
logger.info({ port }, 'evidence plane listening (append-only)');
// Probes cannot present client certificates; with mTLS on, health lives on its own port.
if (tls) startHealthServer(Number(process.env['HEALTH_PORT'] ?? 9000), () => writer.ping());
