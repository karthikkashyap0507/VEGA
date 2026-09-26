import { createLogger, internalServerTls, loadTls, startHealthServer, mtlsFetch } from '@vega/shared';
import { buildExecutionApp } from './app.js';
import { EvidenceAppendClient } from './evidence-append.js';

const logger = createLogger('execution');
const evidenceUrl = process.env['EVIDENCE_URL'] ?? 'http://localhost:3004';
const token = process.env['EVIDENCE_APPEND_TOKEN'];
if (!token) logger.warn('EVIDENCE_APPEND_TOKEN is not set: execution will report NOT READY');

const tls = loadTls();
if (!tls) logger.warn('DEV: plain HTTP; in a cluster execution serves and calls evidence over mTLS only');
const app = await buildExecutionApp({
  ...(token ? { evidence: new EvidenceAppendClient(evidenceUrl, token, tls ? mtlsFetch(tls) : undefined) } : {}),
  ...(tls ? { https: internalServerTls(tls) } : {}),
});
const port = Number(process.env['EXECUTION_PORT'] ?? 3003);
await app.listen({ port, host: process.env['HOST'] ?? '127.0.0.1' });
logger.info({ port }, 'execution plane listening (stub until Module 3/4)');
// Probes cannot present client certificates; with mTLS on, health lives on its own port.
if (tls) startHealthServer(Number(process.env['HEALTH_PORT'] ?? 9000), async () => Boolean(token));
