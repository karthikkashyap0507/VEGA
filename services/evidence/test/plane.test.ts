import { Writable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@vega/shared';
import { EvidenceWriter, migrateEvidence } from '@vega/db/evidence';
import { EvidenceAppendClient } from '@vega/service-execution';
import { injectFetch } from '@vega/service-control';
import type { FastifyInstance } from 'fastify';
import { buildEvidenceApp } from '../src/app.js';

/**
 * INVARIANT 1 at the database and service boundary (PROJECT.md §10.2):
 *   "The execution plane can append to the evidence plane but never read, modify, or delete it."
 *
 * The network-policy half runs against a deployed cluster (infra/k8s, CI plane-separation job).
 * This suite covers the half that does not need one: the only route is /append, the writer
 * role can INSERT and nothing else, and not even the OWNER can rewrite history.
 */

const OWNER = process.env['EVIDENCE_DATABASE_URL'] ?? 'postgresql://vega_evi:vega_evi_local_dev_only@localhost:5433/vega_evidence';
const WRITER = process.env['EVIDENCE_WRITER_URL'] ?? 'postgresql://vega_evi_writer:vega_evi_writer_local@localhost:5433/vega_evidence';
const TOKEN = 'test-append-token';
const TENANT = '7a2c1d33-2b6e-4a5f-8f2e-1c9d0b7a6e22';

let app: FastifyInstance;
let writer: EvidenceWriter;
let appender: EvidenceAppendClient;

beforeAll(async () => {
  await migrateEvidence(OWNER);
  writer = new EvidenceWriter(WRITER);
  app = await buildEvidenceApp({
    writer,
    appendToken: TOKEN,
    logger: createLogger('t', { level: 'silent' }, new Writable({ write: (_c, _e, cb) => cb() })),
  });
  appender = new EvidenceAppendClient('http://evidence.internal', TOKEN, injectFetch(app));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await writer?.close();
});

async function asRole<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe('the execution plane appends through /append and nothing else', () => {
  it('execution → evidence /append succeeds', async () => {
    const receipt = await appender.append({ tenantId: TENANT, kind: 'plane.wiring', payload: { ok: true } });
    expect(receipt.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('refuses an append without the service credential', async () => {
    const res = await app.inject({ method: 'POST', url: '/append', payload: { tenantId: TENANT, source: 'x', kind: 'y', payload: {} } });
    expect(res.statusCode).toBe(401);
  });

  it('refuses malformed entries', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/append',
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { tenantId: 'not-a-uuid', source: 'x', kind: 'y', payload: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('exposes no read, update or delete route at all', async () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const) {
      for (const url of ['/append', '/entries', '/entries/1']) {
        const res = await app.inject({ method, url, headers: { authorization: `Bearer ${TOKEN}` } });
        expect([404, 405], `${method} ${url}`).toContain(res.statusCode);
      }
    }
  });
});

describe('the writer role is INSERT-only (layer 2)', () => {
  it('cannot SELECT', async () => {
    await expect(asRole(WRITER, (c) => c.query('SELECT * FROM evidence_inbox'))).rejects.toThrow(/permission denied/);
  });
  it('cannot UPDATE', async () => {
    await expect(asRole(WRITER, (c) => c.query(`UPDATE evidence_inbox SET kind = 'x'`))).rejects.toThrow(/permission denied/);
  });
  it('cannot DELETE or TRUNCATE', async () => {
    await expect(asRole(WRITER, (c) => c.query('DELETE FROM evidence_inbox'))).rejects.toThrow(/permission denied/);
    await expect(asRole(WRITER, (c) => c.query('TRUNCATE evidence_inbox'))).rejects.toThrow(/permission denied/);
  });
});

describe('the append-only trigger binds even the owner (layer 3)', () => {
  it('UPDATE, DELETE and TRUNCATE raise for the owner', async () => {
    for (const sql of [`UPDATE evidence_inbox SET kind = 'rewritten'`, 'DELETE FROM evidence_inbox', 'TRUNCATE evidence_inbox']) {
      await expect(asRole(OWNER, (c) => c.query(sql))).rejects.toThrow(/append-only/);
    }
  });

  it('the history is still there afterwards', async () => {
    const { rows } = await asRole(OWNER, (c) => c.query(`SELECT count(*)::int AS n FROM evidence_inbox WHERE kind = 'plane.wiring'`));
    expect(rows[0].n).toBeGreaterThan(0);
  });
});
