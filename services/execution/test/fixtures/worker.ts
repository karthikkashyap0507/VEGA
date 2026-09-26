import Fastify from 'fastify';
import { forwardingFetch } from '@vega/connector-testing';
import { DbosOrchestrator } from '@vega/orchestration';
import { registerRunApi, RUN_WORKFLOW, runWorkflow } from '../../src/executor/index.js';
import { dbosUrl, executorKit, silent } from '../fixtures.js';

/**
 * A disposable executor process for the durability suite: the real workflow, the real engine,
 * the connector runtime pointed at the parent's sandbox provider. The parent SIGKILLs it at the
 * worst moments and starts another; DBOS recovers the run in the new process.
 */
const env = process.env;
const kit = await executorKit(forwardingFetch(env['SANDBOX_URL']!));
const orchestrator = new DbosOrchestrator({ appName: 'vega-durability-test', systemDatabaseUrl: dbosUrl(env['SYSTEM_DB']!), logLevel: 'error' });
orchestrator.register(RUN_WORKFLOW, runWorkflow(kit.deps));
await orchestrator.launch();
const app = Fastify();
registerRunApi(app, { orchestrator, store: kit.store, token: env['SERVICE_TOKEN']!, log: silent });
await app.listen({ port: 0, host: '127.0.0.1' });
if (env['START_RUN']) await orchestrator.start(RUN_WORKFLOW, env['START_RUN'], { tenantId: env['TENANT_ID']!, runId: env['START_RUN'] });
const address = app.server.address();
process.stdout.write(`READY ${typeof address === 'object' && address ? address.port : 0}\n`);
