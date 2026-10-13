#!/usr/bin/env node
/**
 * `pnpm dev:setup` — from a fresh clone (after `pnpm install`) to a stack `pnpm dev` can run on.
 * Every step is idempotent, so it is also the way to repair a half-set-up machine.
 *
 *   1. .env                      pnpm env:init (secrets generated; your values kept)
 *   2. Docker services           docker compose up -d, then wait until each one answers
 *   3. identity                  pnpm idp:bootstrap (Zitadel project, app and provisioner keys)
 *   4. database                  pnpm db:migrate
 *   5. policy distribution       pnpm policy:setup, then OPA restarted to load it
 *
 * Plain Node, no dependencies: it runs before anything is built, on Windows as on Linux/macOS.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = ['compose', '-f', 'infra/docker/docker-compose.yml'];
const WINDOWS = process.platform === 'win32';

const step = (n, what) => console.log(`\n[${n}/5] ${what}`);
const fail = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

/** Runs a command in the repository root, output streamed; returns whether it succeeded. */
function run(cmd, args, { quiet = false } = {}) {
  // pnpm is a .cmd shim on Windows, which only a shell can start.
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: quiet ? 'pipe' : 'inherit', shell: WINDOWS && cmd === 'pnpm' });
  return r.status === 0;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, check, seconds = 180) {
  process.stdout.write(`      waiting for ${what} `);
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (await check().catch(() => false)) {
      console.log('✓');
      return;
    }
    process.stdout.write('.');
    await sleep(2000);
  }
  console.log('');
  fail(`${what} did not come up within ${seconds}s — see \`pnpm stack:logs\``);
}

const http = (url, ok = (res) => res.ok) => async () => ok(await fetch(url, { signal: AbortSignal.timeout(3000) }));
const pgReady = (service, user, db) => async () => run('docker', [...COMPOSE, 'exec', '-T', service, 'pg_isready', '-U', user, '-d', db], { quiet: true });

step(1, '.env');
if (!run('node', ['scripts/init-env.mjs'])) fail('could not prepare .env');

step(2, 'Docker services');
if (!run('docker', ['info'], { quiet: true })) fail('Docker is not running. Start Docker Desktop (or the Docker daemon) and run this again.');
if (!run('docker', [...COMPOSE, 'up', '-d'])) fail('docker compose up failed');
await waitFor('Postgres (primary)', pgReady('postgres', 'vega', 'vega'));
await waitFor('Postgres (evidence)', pgReady('postgres-evidence', 'vega_evi', 'vega_evidence'));
await waitFor('Zitadel', async () => existsSync(join(ROOT, 'infra/docker/secrets/zitadel-bootstrap.pat')) && (await http('http://localhost:8080/debug/ready')()));
await waitFor('OpenFGA', http('http://localhost:8081/healthz'));
await waitFor('object storage (SeaweedFS)', http('http://localhost:8333/', () => true));

step(3, 'identity (Zitadel project, OIDC app, provisioner)');
if (!run('pnpm', ['idp:bootstrap'])) fail('identity bootstrap failed');

step(4, 'database migrations');
if (!run('pnpm', ['db:migrate'])) fail('migrations failed');

step(5, 'policy distribution (signing key, OPA configuration, signed baseline bundles)');
if (!run('pnpm', ['policy:setup'])) fail('policy setup failed');
if (!run('docker', [...COMPOSE, 'restart', 'opa'], { quiet: true })) fail('could not restart OPA');
await waitFor('OPA to load the signed presets bundle', http('http://localhost:8181/v1/data/system/bundles/presets/manifest/revision', async (res) => res.ok && (await res.text()).includes('presets')));
await waitFor('Presidio', http('http://localhost:5002/health'), 240);

console.log(`
✓ Ready. Start the platform:

    pnpm dev

  then open http://localhost:3000 and choose "Create a workspace" (local development sets the
  owner's password directly). Zitadel's console: http://localhost:8080 (admin / Password1!).
`);
