import { createLogger, internalServerTls, loadTls, startHealthServer } from '@vega/shared';
import { AnthropicClient } from '@vega/llm';
import { buildExtractorApp } from './app.js';
import { devModel, Extractor } from './extract.js';

const logger = createLogger('extractor');
const env = process.env;
const production = env['NODE_ENV'] === 'production';
const token = env['EXTRACTOR_TOKEN'];
if (!token) throw new Error('EXTRACTOR_TOKEN is required');
const key = env['ANTHROPIC_API_KEY'] || env['LITELLM_MASTER_KEY'];
let model;
if (key) {
  model = new AnthropicClient({ apiKey: key, ...(env['LITELLM_BASE_URL'] && !env['ANTHROPIC_API_KEY'] ? { baseUrl: env['LITELLM_BASE_URL'] } : {}) });
} else {
  if (production) throw new Error('a model key is required in production (ANTHROPIC_API_KEY or LITELLM_MASTER_KEY)');
  logger.warn('DEV: no model key — using the deterministic development pattern model, not an LLM');
  model = devModel();
}
const tls = loadTls();
if (!tls && production) throw new Error('TLS_* is required in production: the extractor serves mTLS only');
const app = await buildExtractorApp({
  extractor: new Extractor(model, env['MODEL_EXTRACTOR'] ?? 'claude-haiku-4-5-20251001'),
  token,
  ...(tls ? { https: internalServerTls(tls) } : {}),
});
const port = Number(env['EXTRACTOR_PORT'] ?? 3006);
await app.listen({ port, host: env['HOST'] ?? '127.0.0.1' });
logger.info({ port }, 'quarantined extractor listening (no tools, no connector credentials)');
if (tls) startHealthServer(Number(env['HEALTH_PORT'] ?? 9000), async () => true);
