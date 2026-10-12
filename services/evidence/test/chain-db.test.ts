import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readZip, verifyPack, type PublicKeyRecord } from '@vega/verifier';
import { sha256 } from '../src/chain/canonical.js';
import { evidencePlane, json, OWNER, READER, TOKENS, WRITER, type Plane } from './harness.js';

/**
 * The signed chain against a real evidence database (module7.md §11). Blocking suites:
 * sequence gaps under parallel appends, append-only with every credential, signatures checked
 * by the published verifier, redaction that keeps the chain verifiable, anchoring, and packs
 * built from the database that the verifier accepts.
 */

let p: Plane;
beforeAll(async () => {
  p = await evidencePlane();
}, 60_000);
afterAll(async () => p?.close());

const append = (tenantId: string, kind: string, payload: Record<string, unknown>, content?: Array<{ data: string; mediaType?: string; sensitivity?: 'body' | 'metadata' }>) =>
  p.app.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.append}` }, payload: { tenantId, source: 'execution', kind, payload, ...(content ? { content } : {}) } });
const query = (url: string, method: 'GET' | 'POST' = 'GET', payload?: unknown) =>
  p.app.inject({ method, url, headers: { authorization: `Bearer ${TOKENS.query}` }, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}) });

async function asRole<T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe('sequence gaps (BLOCKING): parallel appends', () => {
  it('4 tenants × 50 concurrent appends → each chain is 1..50, linked, signed, no gaps', async () => {
    const tenants = [p.tenant(), p.tenant(), p.tenant(), p.tenant()];
    const results = await Promise.all(tenants.flatMap((t) => Array.from({ length: 50 }, (_, i) => append(t, 'action.pre', { action_id: `a-${i}`, n: i }))));
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    for (const t of tenants) {
      const seqs = results.map((r) => r.json() as { seq: number }).filter((_r, i) => tenants[Math.floor(i / 50)] === t).map((r) => r.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
      const check = await p.verifier.verify(t, { full: true });
      expect(check.failures).toEqual([]);
      expect(check).toMatchObject({ ok: true, entries: 50, headSeq: 50, signaturesChecked: 50 });
    }
  }, 120_000);
});

describe('append-only (BLOCKING): UPDATE / DELETE / TRUNCATE with every credential', () => {
  const tables = ['audit_entries', 'audit_entries_p3', 'signing_keys', 'anchors', 'content_objects', 'redactions', 'evidence_packs', 'evidence_pack_builds', 'replay_runs', 'chain_verifications'];
  it('the writer cannot read any of it — only learn the head', async () => {
    for (const t of tables) await expect(asRole(WRITER, (c) => c.query(`SELECT * FROM ${t} LIMIT 1`)), t).rejects.toThrow(/permission denied/);
    const t = p.tenant();
    await append(t, 'admin', { x: 1 });
    const head = await asRole(WRITER, (c) => c.query('SELECT * FROM evidence_chain_head($1)', [t]));
    expect(head.rows[0]).toMatchObject({ seq: '1' });
    expect(Object.keys(head.rows[0])).toEqual(['seq', 'entry_hash']);
  });
  it('the writer and the reader are refused by the grant; the owner by the trigger', async () => {
    for (const url of [WRITER, READER]) {
      for (const t of tables) {
        for (const sql of [`UPDATE ${t} SET ${t === 'signing_keys' ? 'key_id = key_id' : 'tenant_id = tenant_id'}`, `DELETE FROM ${t}`, `TRUNCATE ${t}`]) {
          await expect(asRole(url, (c) => c.query(sql)), `${sql} as ${url.split(':')[1]}`).rejects.toThrow(/permission denied|append-only/);
        }
      }
    }
    for (const t of tables) {
      for (const sql of [`UPDATE ${t} SET ${t === 'signing_keys' ? 'key_id = key_id' : 'tenant_id = tenant_id'}`, `DELETE FROM ${t}`, `TRUNCATE ${t}`]) {
        await expect(asRole(OWNER, (c) => c.query(sql)), `${sql} as owner`).rejects.toThrow(/append-only/);
      }
    }
  }, 60_000);
  it('a forged row inserted directly (bypassing the service) is caught by verification', async () => {
    const t = p.tenant();
    for (let i = 0; i < 3; i++) await append(t, 'admin', { i });
    await asRole(WRITER, (c) =>
      c.query(
        `INSERT INTO audit_entries (tenant_id, seq, id, ts, kind, source, payload_json, payload_digest, prev_hash, entry_hash, signature, key_id, leaf_index)
         VALUES ($1, 4, gen_random_uuid(), now(), 'admin', 'execution', '{"i":99}', $2, $3, $4, 'ML-DSA-65:AAAA', 'vega-evidence-dev', 3)`,
        [t, sha256('{"i":99}'), `sha256:${'1'.repeat(64)}`, `sha256:${'2'.repeat(64)}`],
      ),
    );
    const check = await p.verifier.verify(t, { full: true, record: false });
    expect(check.ok).toBe(false);
    expect(check.failures.map((f) => f.check)).toEqual(expect.arrayContaining(['hash', 'link', 'signature']));
  });
});

describe('the two doors', () => {
  it('the append credential opens /append and nothing else', async () => {
    const t = p.tenant();
    for (const url of [`/query/${t}/entries`, `/query/${t}/head`, '/public/keys', `/public/anchors/${t}`]) {
      const r = await p.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${TOKENS.append}` } });
      expect(r.statusCode, url).toBe(401);
    }
  });
  it('deployed as two listeners, each opens only its own door (network policy can then tell them apart by port)', async () => {
    const { buildEvidenceApp } = await import('../src/app.js');
    const base = { writer: p.writer, reader: p.reader, appendToken: TOKENS.append, queryToken: TOKENS.query, logger: (p.app as unknown as { log: never }).log, chain: p.chain };
    const appendDoor = await buildEvidenceApp({ ...base, doors: { append: true, query: false } });
    const queryDoor = await buildEvidenceApp({ ...base, doors: { append: false, query: true } });
    const t = p.tenant();
    expect((await appendDoor.inject({ method: 'GET', url: `/query/${t}/head`, headers: { authorization: `Bearer ${TOKENS.query}` } })).statusCode).toBe(404);
    expect((await appendDoor.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.append}` }, payload: { tenantId: t, source: 'x', kind: 'admin', payload: {} } })).statusCode).toBe(201);
    expect((await queryDoor.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.append}` }, payload: { tenantId: t, source: 'x', kind: 'admin', payload: {} } })).statusCode).toBe(404);
    expect((await queryDoor.inject({ method: 'GET', url: `/query/${t}/head`, headers: { authorization: `Bearer ${TOKENS.query}` } })).statusCode).toBe(200);
    await appendDoor.close();
    await queryDoor.close();
  });
  it('the query credential cannot append', async () => {
    const r = await p.app.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.query}` }, payload: { tenantId: p.tenant(), source: 'x', kind: 'admin', payload: {} } });
    expect(r.statusCode).toBe(401);
  });
  it('the source recorded is the credential’s, not the caller’s claim', async () => {
    const t = p.tenant();
    await p.app.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.control}` }, payload: { tenantId: t, source: 'execution', kind: 'admin', payload: { by: 'control' } } });
    const [e] = await p.reader.entries({ tenantId: t }, { limit: 1 });
    expect(e!.source).toBe('control');
  });
  it('a payload Postgres cannot store is refused up front, not half-written', async () => {
    const r = await append(p.tenant(), 'admin', { s: 'a\u0000b' });
    expect(r.statusCode).toBe(400);
  });
});

describe('content, redaction and the chain (BLOCKING: redaction keeps the chain verifiable)', () => {
  it('content is stored by digest; redaction removes the plaintext, is itself an entry, and the chain still verifies', async () => {
    const t = p.tenant();
    const body = { to: ['peter@client.example'], body: 'Dear Peter, the numbers are final.' };
    const bytes = Buffer.from(JSON.stringify(body));
    const r = await append(t, 'action.pre', { action_id: 'act-1', arguments_digest: sha256(bytes), subjects: ['peter@client.example'] }, [json(body)]);
    expect(r.json().contentDigests).toEqual([sha256(bytes)]);
    expect((await p.content.get(t, sha256(bytes)))!.equals(bytes)).toBe(true);

    const red = await query(`/query/${t}/redactions`, 'POST', { digest: sha256(bytes), requestId: 'GDPR-2026-0042', reason: 'erasure request from the data subject', requestedBy: 'user-1' });
    expect(red.statusCode).toBe(201);
    expect(p.objects.objects.size === 0 || ![...p.objects.objects.keys()].some((k) => k.endsWith(sha256(bytes).slice(7)))).toBe(true);
    const gone = await query(`/query/${t}/content/${sha256(bytes)}?bodies=true`);
    expect(gone.statusCode).toBe(410);
    const [entry] = await p.reader.entries({ tenantId: t, kinds: ['redaction'] }, { limit: 1 });
    expect(entry!.payload).toMatchObject({ digest: sha256(bytes), requestId: 'GDPR-2026-0042' });
    expect((await p.verifier.verify(t, { full: true })).ok).toBe(true);
  });
  it('bodies are gated: metadata is readable, a body needs bodies=true', async () => {
    const t = p.tenant();
    const r = await append(t, 'action.post', { action_id: 'x' }, [{ ...json({ secret: 1 }), sensitivity: 'body' }, { ...json({ summary: 'ok' }), sensitivity: 'metadata' }]);
    const [body, meta] = r.json().contentDigests as string[];
    expect((await query(`/query/${t}/content/${body}`)).statusCode).toBe(403);
    expect((await query(`/query/${t}/content/${body}?bodies=true`)).statusCode).toBe(200);
    expect((await query(`/query/${t}/content/${meta}`)).statusCode).toBe(200);
  });
});

describe('anchors, the explorer query and packs from the database', () => {
  it('anchors twice, builds a pack, and the published verifier says VERIFIED', async () => {
    const t = p.tenant();
    const secret = { body: 'Dear Peter' };
    for (let i = 1; i <= 6; i++) {
      await append(t, 'action.pre', { action_id: `act-${i}`, run_id: 'run-1', tool: { id: i % 2 ? 'gmail.send' : 'gcal.create' }, risk: { tier: i === 3 ? 'CRITICAL' : 'LOW' }, subjects: ['peter@client.example'], ...(i === 2 ? { arguments_digest: sha256(Buffer.from(JSON.stringify(secret))) } : {}) }, i === 2 ? [json(secret)] : undefined);
    }
    const a1 = await query(`/query/${t}/anchors`, 'POST');
    expect(a1.statusCode).toBe(201);
    expect(a1.json()).toMatchObject({ treeSize: 6 });
    for (let i = 7; i <= 9; i++) await append(t, 'action.post', { action_id: `act-${i}`, run_id: 'run-1', outcome: 'COMMITTED' });
    await query(`/query/${t}/redactions`, 'POST', { digest: sha256(Buffer.from(JSON.stringify(secret))), requestId: 'REQ-1', reason: 'erasure', requestedBy: 'u' });

    // The explorer: facets and cursor pagination.
    const page1 = (await query(`/query/${t}/entries?limit=4&subject=PETER@client.example`)).json();
    expect(page1.items.map((e: { seq: number }) => e.seq)).toEqual([6, 5, 4, 3]);
    const page2 = (await query(`/query/${t}/entries?limit=4&subject=peter@client.example&cursor=${page1.nextCursor}`)).json();
    expect(page2.items.map((e: { seq: number }) => e.seq)).toEqual([2, 1]);
    expect(page2.nextCursor).toBeNull();
    expect((await query(`/query/${t}/entries?riskTier=CRITICAL`)).json().items).toHaveLength(1);
    expect((await query(`/query/${t}/entries/count?runId=run-1`)).json().count).toBe(9);

    const req = await query(`/query/${t}/packs`, 'POST', { tenantSlug: 'acme', requestedBy: 'officer-1', includeBodies: false, query: { runId: 'run-1' } });
    expect(req.statusCode).toBe(202);
    const id = req.json().id as string;
    await p.packs.wait(id);
    const status = (await query(`/query/${t}/packs/${id}`)).json();
    expect(status).toMatchObject({ status: 'built', entryCount: 10 }); // 9 + the redaction entry
    const zip = await query(`/query/${t}/packs/${id}/download`);
    expect(zip.statusCode).toBe(200);
    const files = readZip(new Uint8Array(zip.rawPayload));
    const keys = (await query('/public/keys')).json().keys as PublicKeyRecord[];
    const published = (await query(`/public/anchors/${t}`)).json().anchors;
    const report = verifyPack(files, { trustedKeys: keys, publishedAnchors: published });
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(report.verified).toBe(true);
    expect(report.checks.find((c) => c.id === 'consistency')!.label).toMatch(/Consistency with 1 earlier anchor confirmed/);
    expect(report.checks.find((c) => c.id === 'redactions')!.status).toBe('warn');
    expect(report.checks.find((c) => c.id === 'published')!.status).toBe('ok');
    expect(new TextDecoder().decode(files.get('control-map.md'))).toMatch(/EU AI Act Art\. 12/);
    expect([...files.keys()].some((k) => k.startsWith('verifier/vega-verify'))).toBe(true);

    // Every build is itself an entry.
    const [built] = await p.reader.entries({ tenantId: t, kinds: ['evidence.pack_built'] }, { limit: 1 });
    expect(built!.payload).toMatchObject({ packId: id, entryCount: 10, requestedBy: 'officer-1' });
    const head = (await query(`/query/${t}/head`)).json();
    expect(head.head.seq).toBe(11);
  }, 120_000);
});
