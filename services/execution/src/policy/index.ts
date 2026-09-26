import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OpaClient, PatternClassifier, PresidioClassifier, type Classifier } from '@vega/policy-engine';
import { PolicyEngine, type Alerter, type PolicyEngineLog } from './engine.js';

export * from './engine.js';

/**
 * Wiring from the environment (docs/module5.md §9, §10):
 *
 *   OPA_URL                 the OPA sidecar/service holding the signed bundles (required)
 *   PRESIDIO_ANALYZER_URL   the Presidio analyzer (required in production)
 *   NTFY_URL                where fail-closed alerts are paged (topic `policy`)
 *
 * Development without Presidio uses the pattern classifier — loudly, because it has no NER: a
 * name or an address in a draft is invisible to it. Production refuses to start without it.
 */
export function policyEngineFromEnv(env: NodeJS.ProcessEnv, log: PolicyEngineLog, production: boolean): PolicyEngine {
  const opaUrl = env['OPA_URL'];
  if (!opaUrl && production) throw new Error('OPA_URL is required in production: every action is decided by the policy engine');
  if (!opaUrl) log.warn({}, 'DEV: OPA_URL unset — using http://localhost:8181; with no OPA there, EVERY action is denied (fail closed)');
  let classifier: Classifier;
  let classifierName: string;
  const presidio = env['PRESIDIO_ANALYZER_URL'];
  if (presidio) {
    classifier = new PresidioClassifier(presidio, { timeoutMs: Number(env['PRESIDIO_TIMEOUT_MS'] ?? 2_000) });
    classifierName = 'presidio';
  } else {
    if (production) throw new Error('PRESIDIO_ANALYZER_URL is required in production: sensitivity is a risk input');
    log.warn({}, 'DEV: PRESIDIO_ANALYZER_URL unset — pattern classification only (no names, no addresses): sensitivity is UNDER-estimated');
    classifier = new PatternClassifier();
    classifierName = 'pattern-dev';
  }
  const ntfy = env['NTFY_URL'];
  const alerter: Alerter | undefined = ntfy
    ? {
        async alert(a) {
          await fetch(`${ntfy.replace(/\/$/, '')}/policy`, {
            method: 'POST',
            headers: { title: 'Policy engine unavailable — actions denied', priority: '5', tags: 'no_entry' },
            body: `${a.kind}: ${a.message} — tenant ${a.tenantId}, run ${a.runId}, tool ${a.toolId}. Nothing proceeds until the engine answers.`,
            signal: AbortSignal.timeout(2_000),
          });
        },
      }
    : undefined;
  return new PolicyEngine({
    opa: new OpaClient({ baseUrl: opaUrl ?? 'http://localhost:8181', timeoutMs: Number(env['OPA_TIMEOUT_MS'] ?? 500) }),
    classifier,
    classifierName,
    log,
    alerter,
  });
}

const Classify = z.object({ tenantId: z.string().uuid(), text: z.string().max(200_000) });

function authorized(req: FastifyRequest, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * `POST /internal/classify` (module5.md §7, internal): content → entities, sensitivity, labels.
 * The control plane calls it for dry-run scoring; the content is never stored, only its digest.
 */
export function registerPolicyApi(app: FastifyInstance, deps: { engine: PolicyEngine; token: string }) {
  app.post('/internal/classify', async (req, reply) => {
    if (!authorized(req, deps.token)) return reply.code(401).send({ error: 'unauthorized' });
    const body = Classify.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid', issues: body.error.issues });
    try {
      const c = await deps.engine.classify(body.data.tenantId, body.data.text);
      return c ?? { digest: null, entities: [], sensitivity: 0, labels: [] };
    } catch (e) {
      return reply.code(503).send({ error: 'classifier_unavailable', message: e instanceof Error ? e.message : String(e) });
    }
  });
}
