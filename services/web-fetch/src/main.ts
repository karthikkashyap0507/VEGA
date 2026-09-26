import { createLogger, internalServerTls, loadTls, startHealthServer } from '@vega/shared';
import { buildWebFetchApp } from './app.js';

const logger = createLogger('web-fetch');
const production = process.env['NODE_ENV'] === 'production';
const tls = loadTls();
if (!tls) {
  if (production) throw new Error('TLS_* is required in production: web-fetch serves mTLS only');
  logger.warn('DEV: plain HTTP; in a cluster web-fetch accepts only mTLS clients from the execution plane');
}
const app = await buildWebFetchApp({ ...(tls ? { https: internalServerTls(tls) } : {}) });
const port = Number(process.env['WEB_FETCH_PORT'] ?? 3005);
await app.listen({ port, host: process.env['HOST'] ?? '127.0.0.1' });
logger.info({ port }, 'web-fetch listening (no credentials held)');
if (tls) startHealthServer(Number(process.env['HEALTH_PORT'] ?? 9000), async () => true);
