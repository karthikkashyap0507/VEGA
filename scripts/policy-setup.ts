import { createLogger } from '@vega/shared';
import { s3FromEnv } from '@vega/objectstore';
import { loadBundleKey, PolicyPublisher } from '../services/control/src/policy/publisher.js';

/**
 * `pnpm policy:setup` — Module 5 development set-up, before (or instead of) the control plane's
 * first start:
 *
 *   1. the ES256 bundle signing key          infra/docker/secrets/opa-bundle-key.pem (gitignored)
 *   2. OPA's configuration, with the public key and signed discovery   …/secrets/opa-config.yaml
 *   3. the presets bundle and the discovery bundle in object storage (SeaweedFS)
 *
 * Then `docker compose restart opa` if OPA was already running. Deployed environments get the key
 * from the secret store and OPA's configuration from the Helm chart; the control plane publishes
 * the baseline on every start.
 */
async function main() {
  const env = process.env;
  const log = createLogger('policy-setup');
  const key = loadBundleKey({
    pem: env['OPA_BUNDLE_SIGNING_KEY'],
    path: env['OPA_BUNDLE_SIGNING_KEY_PATH'] ?? './infra/docker/secrets/opa-bundle-key.pem',
    production: false,
    log,
    ...(env['OPA_STORE_URL'] ? { storeUrl: env['OPA_STORE_URL'] } : {}),
  });
  const publisher = new PolicyPublisher(s3FromEnv(env, env['S3_BUCKET_POLICY'] ?? 'vega-policy'), key, log);
  await publisher.publishBaseline();
  log.info('policy distribution ready: restart the opa container if it was already running');
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
