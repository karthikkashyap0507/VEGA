import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT } from '@vega/idp';
import { readZip, verifyPack } from '@vega/verifier';
import type { PolicyActivatedRecord } from '@vega/contracts';
import { PRINCIPAL_HEADER } from '../src/app.js';
import { EvidenceClient } from '../src/evidence/client.js';
import { injectFetch } from '../src/inject-fetch.js';
import type { PolicyPublisher } from '../src/policy/publisher.js';
import { evidencePlane, TOKENS, type Plane } from '../../evidence/test/harness.js';
import { createHarness, problemOf, type Harness } from './harness.js';

/**
 * THE EVIDENCE API AS THE CONTROL PLANE SERVES IT (docs/module7.md §7, §10, §14.1) — real
 * Postgres, OpenFGA and a real evidence plane: who may read the chain, read bodies, build packs,
 * replay, redact; what each plan exposes; the public keys and anchors; and a policy activation
 * landing in the chain with its documents.
 */

vi.setConfig({ testTimeout: 60_000 });
process.env['LOCAL_KEK_BASE64'] ??= randomBytes(32).toString('base64');

const owner = new pg.Pool({ connectionString: process.env['DATABASE_URL'] ?? 'postgresql://vega:vega_local_dev_only@localhost:5432/vega', max: 2 });
const q = async <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await owner.query<T>(sql, params)).rows;
let p: Plane;
let h: Harness;
let E: Awaited<ReturnType<Harness['tenant']>>; // enterprise: packs and replay exposed
let F: Awaited<ReturnType<Harness['tenant']>>; // free: the chain is written all the same
const users: Record<'auditor' | 'compliance' | 'member', string> = { auditor: '', compliance: '', member: '' };
let body = '';
const activations: string[] = [];

const append = (tenantId: string, kind: string, payload: Record<string, unknown>, content?: Array<{ data: string; mediaType: string; sensitivity?: 'body' | 'metadata' }>) =>
  p.app.inject({ method: 'POST', url: '/append', headers: { authorization: `Bearer ${TOKENS.append}` }, payload: { tenantId, source: 'execution', kind, payload, ...(content ? { content } : {}) } });

beforeAll(async () => {
  p = await evidencePlane();
  const evidence = new EvidenceClient({ baseUrl: 'http://evidence.internal', queryToken: TOKENS.query, appendToken: TOKENS.control, fetchImpl: injectFetch(p.app) });
  const publisher = { activate: async (t: string) => void activations.push(t), publishDiscovery: async () => undefined } as unknown as PolicyPublisher;
  h = await createHarness({ evidence, policy: { publisher } });
  E = await h.tenant('enterprise');
  F = await h.tenant('free');
  const mk = async (role: string) => (await q<{ id: string }>(`INSERT INTO users (tenant_id, email, display_name, role, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`, [E.tenantId, `${role.toLowerCase()}-${E.tenantId.slice(0, 6)}@example.com`, role, role]))[0]!.id;
  users.auditor = await mk('AUDITOR');
  users.compliance = await mk('COMPLIANCE_OFFICER');
  users.member = await mk('MEMBER');
  const secret = Buffer.from(JSON.stringify({ body: 'Dear Peter, the numbers are final.' }));
  const digest = `sha256:${createHash('sha256').update(secret).digest('hex')}`;
  const r = await append(E.tenantId, 'action.pre', { action_id: 'act-1', run_id: 'run-x', tool: { id: 'gmail.send' }, risk: { tier: 'HIGH' }, arguments_digest: digest, subjects: ['peter@client.example'] }, [{ data: secret.toString('base64'), mediaType: 'application/json' }]);
  body = (r.json().contentDigests as string[])[0]!;
  await append(E.tenantId, 'action.post', { action_id: 'act-1', run_id: 'run-x', outcome: 'COMMITTED' });
  await append(F.tenantId, 'action.pre', { action_id: 'free-1', run_id: 'run-f' });
}, 120_000);

afterAll(async () => {
  await h?.close();
  await p?.close();
  await owner.end();
});

const as = (who: keyof typeof users) => h.as(E.tenantId, users[who]);
const ownerE = () => h.as(E.tenantId, E.userId);

describe('who may read the chain (§10)', () => {
  it('the owner and an auditor read the explorer; a member does not', async () => {
    const page = await ownerE().audit.entries.query({ subject: 'peter@client.example' });
    expect((page.items as Array<{ kind: string }>).map((e) => e.kind)).toEqual(['action.pre']);
    expect((await as('auditor').audit.entries.query({})).items).toHaveLength(2);
    expect((await problemOf(as('member').audit.entries.query({}))).status).toBe(403);
  });
  it('an AUDITOR sees receipts but not bodies; a compliance officer sees both', async () => {
    expect((await problemOf(as('auditor').audit.content.query({ digest: body }))).status).toBe(403);
    const c = await as('compliance').audit.content.query({ digest: body });
    expect(JSON.parse(c.text!)).toEqual({ body: 'Dear Peter, the numbers are final.' });
  });
  it('the chain status widget: head, verification', async () => {
    await ownerE().audit.anchorNow.mutate();
    const v = (await ownerE().audit.verify.mutate({ full: true })) as { ok: boolean; entries: number };
    expect(v).toMatchObject({ ok: true, entries: 2 });
    const head = (await ownerE().audit.head.query()) as { head: { seq: number }; lastAnchor: { treeSize: number }; verification: { ok: boolean } };
    expect(head).toMatchObject({ head: { seq: 2 }, lastAnchor: { treeSize: 2 }, verification: { ok: true } });
  });
});

describe('packs and replay are exposed by plan (§14.1); the chain is not', () => {
  it('free: packs and replay answer entitlement-required — the chain itself is there and readable by its owner', async () => {
    const free = h.as(F.tenantId, F.userId);
    expect((await problemOf(free.evidencePacks.create.mutate({ query: {} }))).type).toBe('https://errors.vega.dev/entitlement-required');
    expect((await problemOf(free.replay.run.mutate({ actionId: 'free-1' }))).type).toBe('https://errors.vega.dev/entitlement-required');
    expect((await free.audit.entries.query({})).items).toHaveLength(1);
  });
  it('an auditor cannot build packs (no evidence.export); a compliance officer can, and the pack verifies', async () => {
    expect((await problemOf(as('auditor').evidencePacks.create.mutate({ query: {} }))).status).toBe(403);
    expect((await problemOf(as('compliance').evidencePacks.create.mutate({ template: 'client', query: {} }))).status).toBe(400); // the template needs a subject
    const { id } = await as('compliance').evidencePacks.create.mutate({ template: 'client', query: { subject: 'peter@client.example' }, includeBodies: true });
    await p.packs.wait(id);
    const st = (await as('compliance').evidencePacks.get.query({ id })) as { status: string; downloadUrl: string; entryCount: number };
    expect(st).toMatchObject({ status: 'built', entryCount: 1, downloadUrl: `/v1/evidence-packs/${id}/download` });
    const dl = await as('compliance').evidencePacks.download.query({ id });
    const files = readZip(new Uint8Array(Buffer.from(dl.base64, 'base64')));
    const r = verifyPack(files, { trustedKeys: await p.chain.publicKeys() });
    expect(r.checks.filter((c) => c.status === 'fail').map((c) => `${c.label}: ${c.detail}`)).toEqual([]);
    expect(JSON.parse(new TextDecoder().decode(files.get('manifest.json'))).tenantSlug).not.toBe(E.tenantId); // the slug, not the id
    expect(files.has(`content/${body.slice(7)}`)).toBe(true); // bodies included because asked AND permitted
    // The build is itself evidence, attributed to the person who asked.
    const built = (await ownerE().audit.entries.query({ kinds: ['evidence.pack_built'] })).items as Array<{ payload: { requestedBy: string } }>;
    expect(built[0]!.payload.requestedBy).toBe(users.compliance);
  });
  it('asking for bodies without audit.read_bodies is refused, not silently downgraded', async () => {
    expect((await problemOf(as('auditor').evidencePacks.create.mutate({ query: {}, includeBodies: true }))).status).toBe(403);
  });
});

describe('redaction (§5.5, §10 "redaction abuse")', () => {
  it('needs bodies access and authority over the records; it is itself a chain entry, and the chain still verifies', async () => {
    expect((await problemOf(as('auditor').audit.redact.mutate({ digest: body, requestId: 'GDPR-1', reason: 'erasure' }))).status).toBe(403);
    await as('compliance').audit.redact.mutate({ digest: body, requestId: 'GDPR-1', reason: 'erasure request' });
    expect((await problemOf(as('compliance').audit.content.query({ digest: body }))).status).toBe(410);
    const red = (await ownerE().audit.entries.query({ kinds: ['redaction'] })).items as Array<{ payload: Record<string, unknown> }>;
    expect(red[0]!.payload).toMatchObject({ digest: body, requestId: 'GDPR-1', requestedBy: users.compliance });
    expect(((await ownerE().audit.verify.mutate({ full: true })) as { ok: boolean }).ok).toBe(true);
  });
});

describe('policy activation is recorded with its documents (§4.1 policy.activated)', () => {
  it('activating a bundle appends the documents in force; packs and replay need nothing else', async () => {
    const yaml = 'id: approve-wires\ndescription: Wires need approval\ncitation: FINRA 3110\nseverity: high\nwhen: { tool.id: bank.wire }\nthen: { decision: REQUIRE_APPROVAL, approver_role: APPROVER }\n';
    const [pol] = await q<{ id: string }>(
      `INSERT INTO policies (tenant_id, key, version, spec_yaml, compiled_rego, citation, description, severity, decision, author_id, state) VALUES ($1, 'approve-wires', 2, $2, 'package x', 'FINRA 3110', 'Wires need approval', 'high', 'REQUIRE_APPROVAL', $3, 'draft') RETURNING id`,
      [E.tenantId, yaml, E.userId],
    );
    const [b] = await q<{ id: string }>(
      `INSERT INTO policy_bundles (tenant_id, version, policy_ids, policy_versions, rego, revision, bundle_ref, digest, signature, created_by) VALUES ($1, 1, ARRAY[$2]::uuid[], $3, 'package x', 'r1', 'ref', 'sha256:bundle', 'sig', $4) RETURNING id`,
      [E.tenantId, pol!.id, JSON.stringify([{ key: 'approve-wires', version: 2 }]), E.userId],
    );
    await q(`INSERT INTO policy_simulations (tenant_id, bundle_id, window_from, window_to, actions_replayed, summary_json, changes_json, run_by) VALUES ($1, $2, now(), now(), 0, '{}', '[]', $3)`, [E.tenantId, b!.id, E.userId]);
    await ownerE().policies.activate.mutate({ bundleId: b!.id });
    expect(activations).toContain(E.tenantId);
    const [entry] = (await ownerE().audit.entries.query({ kinds: ['policy.activated'] })).items as Array<{ source: string; payload: PolicyActivatedRecord }>;
    expect(entry!.source).toBe('control');
    expect(entry!.payload).toMatchObject({ bundle_id: b!.id, version: 1, activated_by: E.userId, policies: [{ key: 'approve-wires', version: 2, citation: 'FINRA 3110' }] });
    const doc = await as('compliance').audit.content.query({ digest: entry!.payload.policies[0]!.document_digest });
    expect(JSON.parse(doc.text!)).toMatchObject({ id: 'approve-wires', then: { decision: 'REQUIRE_APPROVAL' } });
  });
});

describe('public keys and anchors (§7): no account needed', () => {
  it('only the evidence_public system principal reaches them; a signed-in user does not', async () => {
    expect((await problemOf(ownerE().publicEvidence.keys.query())).status).toBe(403);
    const assertion = await h.issuer.mint({ tenantId: SYSTEM_TENANT, userId: 'system:evidence_public', system: 'evidence_public' });
    const client = h.raw({ [PRINCIPAL_HEADER]: assertion });
    const keys = (await client.publicEvidence.keys.query()) as { keys: Array<{ keyId: string; alg: string }> };
    expect(keys.keys[0]).toMatchObject({ alg: 'ML-DSA-65' });
    const [t] = await q<{ slug: string }>(`SELECT slug FROM tenants WHERE id = $1`, [E.tenantId]);
    const anchors = (await client.publicEvidence.anchors.query({ slug: t!.slug })) as { tenantId: string; anchors: Array<{ treeSize: number; signature: string }> };
    expect(anchors.tenantId).toBe(E.tenantId);
    expect(anchors.anchors[0]!.signature).toMatch(/^ML-DSA-65:/);
    expect((await problemOf(client.publicEvidence.anchors.query({ slug: 'no-such-tenant-xyz' }))).status).toBe(404);
  });
});
