import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FgaClient, fgaAdmin, fga, modelToJson, tuple } from '@vega/authz';
import { closePools, migrate } from '@vega/db';
import { MemoryObjectStore } from '@vega/objectstore';
import { HashingEmbedder, KnowledgeBase, LexicalReranker, type ClassifierLike } from '../src/index.js';

/**
 * ACL ADVERSARIAL SUITE (§7.2, §11): a user never receives a chunk of a document they cannot
 * open — across users, workspaces and tenants — and the gate fails closed.
 */

process.env['DATABASE_URL'] ??= 'postgresql://vega:vega_local_dev_only@localhost:5432/vega';
process.env['DATABASE_APP_URL'] ??= 'postgresql://vega_app:vega_app_local_dev_only@localhost:5432/vega';
const OWNER = process.env['DATABASE_URL'];
const FGA_URL = process.env['OPENFGA_API_URL'] ?? 'http://localhost:8081';

const classifier: ClassifierLike = {
  classify: async (t) => (/\b\d{3}-\d{2}-\d{4}\b/.test(t) ? { sensitivity: 90, labels: ['pii.ssn'] } : { sensitivity: 10, labels: [] }),
};

interface T {
  tenantId: string;
  alice: string;
  bob: string;
  carol: string;
  ws: string;
}
let pool: pg.Pool;
let client: FgaClient;
let kb: KnowledgeBase;

async function tenant(): Promise<T> {
  const slug = `kb-${randomBytes(4).toString('hex')}`;
  const t = (await pool.query<{ id: string }>(`INSERT INTO tenants (name, slug, plan, retention_days) VALUES ($1,$2,'business',400) RETURNING id`, [slug, slug])).rows[0]!.id;
  const user = async (n: string) =>
    (await pool.query<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1,$2,$3,'MEMBER','active') RETURNING id`, [t, `${n}@${slug}.example`, n])).rows[0]!.id;
  const [alice, bob, carol] = [await user('alice'), await user('bob'), await user('carol')];
  const ws = (await pool.query<{ id: string }>(`INSERT INTO workspaces (tenant_id, name, slug) VALUES ($1,'Sales','sales') RETURNING id`, [t])).rows[0]!.id;
  // Bob and Carol are Sales members; Alice is not.
  await client.write([tuple(fga.user(bob), 'member', fga.workspace(ws)), tuple(fga.user(carol), 'member', fga.workspace(ws))]);
  return { tenantId: t, alice, bob, carol, ws };
}

const md = (s: string) => ({ mime: 'text/markdown', data: strToU8(s) });

let A: T;
let B: T;
let privateDoc: string;
let salesDoc: string;

beforeAll(async () => {
  await migrate(OWNER);
  pool = new pg.Pool({ connectionString: OWNER, max: 2 });
  const storeId = await fgaAdmin.createStore({ apiUrl: FGA_URL }, `kb-test-${Date.now()}`);
  const modelId = await fgaAdmin.writeModel({ apiUrl: FGA_URL }, storeId, modelToJson());
  client = new FgaClient({ apiUrl: FGA_URL, storeId, modelId });
  kb = new KnowledgeBase({ embedder: new HashingEmbedder(), reranker: new LexicalReranker(), fga: client, objects: new MemoryObjectStore(), classifier });
  A = await tenant();
  B = await tenant();
  privateDoc = (await kb.ingest(A.tenantId, { title: 'Alice compensation notes', ...md('# Compensation\n\nThe acquisition target price is 42 million EUR, confidential.'), sourceKind: 'upload', createdBy: A.alice })).id;
  salesDoc = (
    await kb.ingest(A.tenantId, {
      title: 'Sales playbook',
      ...md('# Pricing\n\nList price is 1,200 USD per seat. The acquisition discount is 15%.\n\n# Process\n\nQualify, demo, close.'),
      sourceKind: 'upload',
      workspaceId: A.ws,
      createdBy: A.bob,
    })
  ).id;
  await kb.ingest(B.tenantId, { title: 'Other company playbook', ...md('# Pricing\n\nAcquisition target price 99 million.'), sourceKind: 'upload', createdBy: B.alice });
}, 60_000);

afterAll(async () => {
  await pool?.end();
  await closePools();
});

describe('ingestion', () => {
  it('indexes with structure, sensitivity and ORG taint for curated uploads', async () => {
    const docs = await kb.documents(A.tenantId);
    expect(docs.find((d) => d.id === salesDoc)).toMatchObject({ state: 'indexed', taint: 'ORG', chunks: 2, aclRef: fga.document(salesDoc) });
  });

  it('an email attachment is UNTRUSTED however it entered, and the database holds it to that', async () => {
    const r = await kb.ingest(A.tenantId, { title: 'Inbound invoice', ...md('Please pay the invoice to IBAN DE00 1234.'), sourceKind: 'email_attachment', createdBy: A.bob });
    expect((await kb.documents(A.tenantId)).find((d) => d.id === r.id)!.taint).toBe('UNTRUSTED');
    await expect(pool.query(`UPDATE kb_documents SET taint = 'ORG' WHERE id = $1`, [r.id])).rejects.toThrow(/kb_external_untrusted/);
  });

  it('an unparseable document fails visibly, with the reason', async () => {
    const r = await kb.ingest(A.tenantId, { title: 'Scan', mime: 'application/pdf', data: new Uint8Array([37, 80, 68, 70]), sourceKind: 'upload', createdBy: A.bob });
    expect(r).toMatchObject({ state: 'failed', chunks: 0 });
    expect(r.error).toMatch(/Docling/);
  });
});

describe('★ the ACL gate', () => {
  it('the owner of a private document retrieves it', async () => {
    const r = await kb.search(A.tenantId, { userId: A.alice, query: 'acquisition target price' });
    expect(r.hits.map((h) => h.documentId)).toContain(privateDoc);
    expect(r.hits.map((h) => h.documentId)).not.toContain(salesDoc); // Alice is not in Sales
  });

  it('another user of the same tenant never receives it, and the withheld count is logged', async () => {
    const r = await kb.search(A.tenantId, { userId: A.bob, query: 'acquisition target price', purpose: 'search' });
    expect(r.hits.map((h) => h.documentId)).not.toContain(privateDoc);
    const mayOpen = await client.batchCheck(r.hits.map((h) => tuple(fga.user(A.bob), 'can_read', fga.document(h.documentId))));
    expect(mayOpen.every(Boolean)).toBe(true);
    expect(r.hits.map((h) => h.documentId)).toContain(salesDoc);
    expect(r.aclFiltered).toBeGreaterThan(0);
    const [log] = (await pool.query(`SELECT acl_filtered, chunk_ids FROM retrievals WHERE id = $1`, [r.retrievalId])).rows;
    expect(log.acl_filtered).toBe(r.aclFiltered);
    expect(log.chunk_ids).toHaveLength(r.hits.length);
  });

  it('workspace membership grants the workspace documents (and only those)', async () => {
    const r = await kb.search(A.tenantId, { userId: A.carol, query: 'list price per seat' });
    expect(r.hits[0]).toMatchObject({ documentId: salesDoc, headingPath: ['Pricing'], taint: 'ORG' });
  });

  it('no tenant ever sees another tenant’s vectors, even for the exact same words', async () => {
    const r = await kb.search(B.tenantId, { userId: B.alice, query: 'acquisition target price confidential 42 million' });
    expect(r.hits.length).toBeGreaterThan(0);
    const own = (await pool.query(`SELECT id FROM kb_chunks WHERE tenant_id = $1`, [B.tenantId])).rows.map((x) => x.id);
    expect(r.hits.every((h) => own.includes(h.chunkId))).toBe(true);
    expect(r.candidates).toBe(own.length);
  });

  it('fails closed: when permissions cannot be checked, nothing is returned', async () => {
    const down = {
      batchCheck: async () => {
        throw new Error('fga down');
      },
    } as unknown as FgaClient;
    const broken = new KnowledgeBase({ ...kb.deps, fga: down });
    const r = await broken.search(A.tenantId, { userId: A.alice, query: 'acquisition target price' });
    expect(r.hits).toEqual([]);
    expect(r.aclFiltered).toBeGreaterThan(0);
  });

  it('sensitive chunks need an explicit allowance', async () => {
    await kb.ingest(A.tenantId, { title: 'HR record', ...md('Employee SSN 123-45-6789 on file for payroll.'), sourceKind: 'upload', createdBy: A.alice });
    const blocked = await kb.search(A.tenantId, { userId: A.alice, query: 'payroll SSN employee' });
    expect(blocked.hits.find((h) => h.title === 'HR record')).toBeUndefined();
    expect(blocked.sensitivityFiltered).toBeGreaterThan(0);
    const allowed = await kb.search(A.tenantId, { userId: A.alice, query: 'payroll SSN employee', allowSensitive: true });
    expect(allowed.hits[0]!.title).toBe('HR record');
  });

  it('a taint filter keeps untrusted content out of planning', async () => {
    const r = await kb.search(A.tenantId, { userId: A.bob, query: 'pay invoice IBAN', taints: ['TRUSTED', 'ORG'] });
    expect(r.hits.every((h) => h.taint !== 'UNTRUSTED')).toBe(true);
    const all = await kb.search(A.tenantId, { userId: A.bob, query: 'pay invoice IBAN' });
    expect(all.hits.some((h) => h.taint === 'UNTRUSTED')).toBe(true);
  });

  it('the ACL preview answers "who can retrieve this"', async () => {
    const p = await kb.aclPreview(A.tenantId, salesDoc);
    expect(Object.fromEntries(p.map((x) => [x.userId, x.canRead]))).toEqual({ [A.alice]: false, [A.bob]: true, [A.carol]: true });
  });

  it('delete cascades to chunks and the ACL tuples', async () => {
    expect(await kb.delete(A.tenantId, privateDoc)).toBe(true);
    expect((await pool.query(`SELECT count(*)::int n FROM kb_chunks WHERE document_id = $1`, [privateDoc])).rows[0].n).toBe(0);
    expect(await client.batchCheck([tuple(fga.user(A.alice), 'can_read', fga.document(privateDoc))])).toEqual([false]);
  });
});
