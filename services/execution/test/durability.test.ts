import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchRegistry } from '@vega/connectors';
import { FakeProviders, serveProviders, type SandboxServer } from '@vega/connector-testing';
import type { RunStatus } from '@vega/contracts';
import type { PendingAction } from '../src/executor/index.js';
import { connect, dbosUrl, executorKit, ownerQuery, plannedRun, seedTenant, setAgentSpec, waitFor, type ExecutorKit, type Tenant } from './fixtures.js';

/**
 * THE DURABILITY SUITE — docs/module4.md §11.1: "deliberate pod kills at every step boundary and
 * mid-activity. Assert after each: no duplicate side effects in the sandbox account, run state
 * consistent, no orphaned workflows." This suite is what earns the right to give an agent write
 * access.
 *
 * Executor WORKER PROCESSES run the real workflow against a sandbox provider served from this
 * process; each case SIGKILLs a worker (no shutdown hook runs, exactly like a lost pod) and
 * starts a fresh one, which recovers the run from the engine's log.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SYSTEM_DB = 'vega_dbos_durability_test';
const SERVICE_TOKEN = 'durability-service-token-0123456789';
const providers = new FakeProviders();
let sandbox: SandboxServer;
let before: ((url: URL, method: string) => Promise<void> | void) | undefined;
let kit: ExecutorKit;
let t: Tenant;
let bindings: Record<string, string>;
const workers: ChildProcess[] = [];

beforeAll(async () => {
  await ownerQuery(`DROP DATABASE IF EXISTS ${SYSTEM_DB} WITH (FORCE)`);
  sandbox = await serveProviders(providers.fetch, { before: (u, m) => before?.(u, m) });
  kit = await executorKit(providers.fetch);
  t = await seedTenant();
  await setAgentSpec(t, 1, { allowedTools: launchRegistry().records().map((r) => r.toolId) });
  bindings = { gmail: await connect(t, 'gmail', (s) => providers.grant('google', t.email, s)) };
}, 60_000);

afterAll(async () => {
  for (const w of workers) if (w.exitCode === null) w.kill('SIGKILL');
  await sandbox?.close();
});

async function worker(startRun?: string): Promise<{ proc: ChildProcess; port: number; kill: () => Promise<void> }> {
  const proc = spawn(process.execPath, ['--import', 'tsx', join(here, 'fixtures', 'worker.ts')], {
    env: { ...process.env, SANDBOX_URL: sandbox.url, SYSTEM_DB, SERVICE_TOKEN, TENANT_ID: t.tenantId, ...(startRun ? { START_RUN: startRun } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  workers.push(proc);
  let stderr = '';
  proc.stderr!.on('data', (d) => (stderr += String(d)));
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    proc.stdout!.on('data', (d) => {
      out += String(d);
      const m = /READY (\d+)/.exec(out);
      if (m) resolve(Number(m[1]));
    });
    proc.on('exit', (code) => reject(new Error(`worker exited (${code}) before ready: ${stderr.slice(-2000)}`)));
  });
  return {
    proc,
    port,
    kill: () =>
      new Promise<void>((r) => {
        if (proc.exitCode !== null || proc.signalCode) return r();
        proc.once('exit', () => r());
        proc.kill('SIGKILL');
      }),
  };
}

const until = (runId: string, ...want: RunStatus[]) =>
  waitFor(async () => {
    const v = await kit.store.view(t.tenantId, runId);
    return v && want.includes(v.status) ? v : null;
  }, 60_000, `run to reach ${want.join('|')}`);

const sent = (subject: string) => providers.google.sent.filter((m) => JSON.stringify(m).includes(subject)).length;

/** No orphaned workflows: the engine's record of the run is finished, not pending. */
async function engineStatus(runId: string): Promise<string | undefined> {
  const pool = new pg.Pool({ connectionString: dbosUrl(SYSTEM_DB), max: 1 });
  try {
    return (await pool.query<{ status: string }>(`SELECT status FROM dbos.workflow_status WHERE workflow_uuid = $1`, [runId])).rows[0]?.status;
  } finally {
    await pool.end();
  }
}

describe('killing the executor (blocking)', () => {
  it('mid-activity on an R2 send: the new worker does NOT resend — the outcome is UNKNOWN and escalated', async () => {
    const subject = 'Kill mid-send';
    const { runId } = await plannedRun(kit, t, `call gmail.send({ to: ["partner-a@${t.domain}"], subject: "${subject}", body: "once" })`, { bindings });
    let arrived!: () => void;
    const reached = new Promise<void>((r) => (arrived = r));
    before = async (u, m) => {
      if (m === 'POST' && u.pathname.endsWith('/messages/send')) {
        arrived();
        await new Promise((r) => setTimeout(r, 1_500)); // the provider applies it; the caller is dead by then
      }
    };
    const w1 = await worker(runId);
    await reached;
    await w1.kill();
    await new Promise((r) => setTimeout(r, 1_700));
    before = undefined;
    expect(sent(subject)).toBe(1); // the provider did send it

    const w2 = await worker();
    const v = await until(runId, 'NEEDS_ATTENTION');
    expect(v.statusReason).toMatch(/never finished|unknown/);
    expect(sent(subject)).toBe(1); // …and nobody sent it again
    expect((await kit.store.nodes(t.tenantId, runId))[0]).toMatchObject({ status: 'unknown' });
    expect(await engineStatus(runId)).toBe('SUCCESS');
    await w2.kill();
  }, 90_000);

  it('after a committed step and mid-read: the read repeats, the committed draft and the send happen once each', async () => {
    const subject = 'Kill mid-read';
    const program = [
      `call gmail.draft({ to: ["partner-b@${t.domain}"], subject: "${subject} draft", body: "d" })`,
      `let found = call gmail.search({ query: "boundary-probe" })`,
      `call gmail.send({ to: ["partner-b@${t.domain}"], subject: "${subject}", body: "s" })`,
    ].join('\n');
    const { runId } = await plannedRun(kit, t, program, { bindings });
    let searches = 0;
    let arrived!: () => void;
    const reached = new Promise<void>((r) => (arrived = r));
    before = async (u, m) => {
      if (m === 'GET' && u.pathname.endsWith('/messages') && u.search.includes('boundary-probe')) {
        searches += 1;
        if (searches === 1) {
          arrived();
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    };
    const draftsBefore = providers.core.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/drafts')).length;
    const w1 = await worker(runId);
    await reached;
    await w1.kill();
    const w2 = await worker();
    await until(runId, 'COMPLETED');
    before = undefined;
    expect(searches).toBe(2); // a read is safe to repeat
    expect(providers.core.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/drafts')).length - draftsBefore).toBe(1);
    expect(sent(subject)).toBe(1);
    expect(await engineStatus(runId)).toBe('SUCCESS');
    await w2.kill();
  }, 90_000);

  it('while waiting for an approval: the wait survives the kill, and the approval lands in the new worker', async () => {
    const subject = 'Kill while waiting';
    providers.google.seedMessage(t.email, { from: 'Client <client@partner.example>', subject: 'waiting-probe', body: 'Please confirm the numbers.' });
    const program = [
      `let inbox = call gmail.search({ query: "waiting-probe" })`,
      `let msg = call gmail.read({ messageId: inbox.messages[0].id })`,
      `let s = extract msg into Summary`,
      `call gmail.send({ to: ["partner-c@${t.domain}"], subject: "${subject}", body: render("summary", { text: s.text }) })`,
    ].join('\n');
    const { runId } = await plannedRun(kit, t, program, { bindings });
    const reads = () => providers.core.calls.filter((c) => c.method === 'GET' && c.url.includes('waiting-probe')).length;
    const w1 = await worker(runId);
    const waiting = await until(runId, 'AWAITING_APPROVAL');
    await w1.kill();
    expect(reads()).toBe(1);

    const w2 = await worker();
    await new Promise((r) => setTimeout(r, 1_000));
    expect((await kit.store.view(t.tenantId, runId))!.status).toBe('AWAITING_APPROVAL');
    const res = await fetch(`http://127.0.0.1:${w2.port}/internal/runs/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${SERVICE_TOKEN}` },
      body: JSON.stringify({ tenantId: t.tenantId, runId, topic: 'decision', message: { key: (waiting.pending as PendingAction).key, decision: 'approve', by: t.userId } }),
    });
    expect(res.status).toBe(202);
    await until(runId, 'COMPLETED');
    expect(sent(subject)).toBe(1);
    expect(reads()).toBe(1); // the journal, not the provider, answered the replay
    expect(await engineStatus(runId)).toBe('SUCCESS');
    await w2.kill();
  }, 90_000);
});
